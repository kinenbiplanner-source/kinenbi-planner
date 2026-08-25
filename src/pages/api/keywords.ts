/**
 * キーワード台帳のCRUD（/api/keywords）。
 *
 *   POST   … リサーチ結果（keywords-research.json 形式）の一括取り込み
 *   PATCH  … ステータス更新（記事化の進捗を台帳に反映する）
 *   DELETE … 1件削除
 *
 * 認証は src/middleware.ts（Cloudflare Access の JWT 検証）が担当する。
 * /admin にしか Access のパスポリシーが掛かっていない以上、この API には
 * 素のリクエストが飛んでくる前提で書く＝入力は全部ここで検証する。
 *
 * 記事側（/api/articles）と違って正規化ロジックを lib へ出していないのは、
 * ここの検証が「DBスキーマの制約」ではなく「取り込むJSONの体裁」の話であり、
 * 使う場所が /admin/keywords の1画面しかないため。
 */
import type { APIRoute } from 'astro';
import {
  deleteKeyword,
  updateKeywordStatus,
  upsertKeyword,
  type KeywordInput,
  type KeywordRow,
} from '../../lib/db';
import { isAxisSlug, isFunnel } from '../../lib/axis';

export const prerender = false;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const data = await request.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** schema.sql の keywords.status と対。ここを増やすときは向こうのコメントも直す。 */
const STATUSES = ['todo', 'writing', 'done', 'dropped'] as const;

function isStatus(v: unknown): v is KeywordRow['status'] {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

/**
 * 1リクエストで受ける件数の上限。
 *
 * upsertKeyword は1件＝1クエリなので、100件送られると D1 を100回叩く。
 * Workers 無料プランのサブリクエスト上限（1リクエストあたり50）に当たって
 * 途中で落ちると「何件入ったか分からない」状態になるため、手前で切る。
 * 画面側（/admin/keywords）はこの数以下に分割して送る。
 */
const MAX_BATCH = 40;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

type ItemOutcome = { ok: true; value: KeywordInput } | { ok: false; message: string };

/** リサーチJSONの1件を KeywordInput に落とす。未指定の項目は schema.sql の既定値に寄せる。 */
function buildKeyword(raw: unknown, index: number): ItemOutcome {
  const where = `${index + 1}件目`;
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: `${where}：オブジェクトではありません` };
  }
  const r = raw as Record<string, unknown>;

  const keyword = str(r.keyword);
  if (!keyword) return { ok: false, message: `${where}：keyword が空です` };

  const axis = str(r.axis);
  if (!isAxisSlug(axis)) {
    return { ok: false, message: `${where}（${keyword}）：axis「${axis}」は gift / date / concierge のいずれかで指定してください` };
  }

  const funnel = str(r.funnel);
  if (!isFunnel(funnel)) {
    return { ok: false, message: `${where}（${keyword}）：funnel「${funnel}」は 集客 / 比較・検討 / 課題解決 のいずれかで指定してください` };
  }

  // priority は「1が最優先」の3段階。数字で来ても文字列で来ても受ける
  // （手で書いたJSONだと "1" になりがちなので、そこで弾くのは実用的でない）。
  const priority = Number(r.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    return { ok: false, message: `${where}（${keyword}）：priority は 1〜3 の整数です` };
  }

  // status は未指定なら todo（リサーチ直後は全部これ）。
  const rawStatus = r.status === undefined || r.status === null || r.status === '' ? 'todo' : r.status;
  if (!isStatus(rawStatus)) {
    return { ok: false, message: `${where}（${keyword}）：status「${String(rawStatus)}」は todo / writing / done / dropped のいずれかです` };
  }

  // article_id は取り込み時点では基本 null。記事化したら PATCH で入る。
  let articleId: number | null = null;
  if (typeof r.article_id === 'number' && Number.isInteger(r.article_id) && r.article_id > 0) {
    articleId = r.article_id;
  }

  // difficulty / volume は判断材料のメモであって集計キーではないので、
  // 表記ゆれ（低/中/高、小/中/大）を厳密に縛らず、空のときだけ既定値を入れる。
  return {
    ok: true,
    value: {
      keyword,
      axis,
      funnel,
      intent: str(r.intent),
      persona: str(r.persona),
      difficulty: str(r.difficulty) || '中',
      volume: str(r.volume) || '中',
      priority,
      status: rawStatus,
      article_id: articleId,
      note: str(r.note),
    },
  };
}

/** 一括取り込み。keyword が既にあれば上書き（リサーチのやり直しを何度でも流せる）。 */
export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return fail(400, 'リクエストの形式が不正です');

  const list = body.keywords;
  if (!Array.isArray(list)) return fail(400, 'keywords 配列がありません');
  if (list.length === 0) return fail(400, 'keywords が空です');
  if (list.length > MAX_BATCH) {
    return fail(400, `一度に取り込めるのは ${MAX_BATCH} 件までです（${list.length} 件届きました）`);
  }

  // 全件検証してから書き込む。1件でも不正なら何も入れない
  // （半分だけ入った状態は、貼り直しで直したいときにいちばん厄介）。
  const inputs: KeywordInput[] = [];
  for (let i = 0; i < list.length; i++) {
    const built = buildKeyword(list[i], i);
    if (!built.ok) return fail(400, built.message);
    inputs.push(built.value);
  }

  // 同じ貼り付けの中でのキーワード重複は、後勝ちで静かに潰すのではなく知らせる
  // （リサーチ結果の作りが壊れているサインなので、気付ける方がいい）。
  const seen = new Set<string>();
  for (const k of inputs) {
    if (seen.has(k.keyword)) return fail(400, `キーワード「${k.keyword}」が重複しています`);
    seen.add(k.keyword);
  }

  for (const k of inputs) {
    await upsertKeyword(k);
  }

  return json({ count: inputs.length, message: `${inputs.length}件を取り込みました` });
};

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** ステータス更新。記事化したときは article_id も一緒に渡す。 */
export const PATCH: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return fail(400, 'リクエストの形式が不正です');

  const id = parseId(body.id);
  if (id === null) return fail(400, 'IDが不正です');

  if (!isStatus(body.status)) {
    return fail(400, 'ステータスは todo / writing / done / dropped のいずれかです');
  }

  const articleId = body.article_id === undefined || body.article_id === null ? null : parseId(body.article_id);
  if (body.article_id !== undefined && body.article_id !== null && articleId === null) {
    return fail(400, 'article_id が不正です');
  }

  await updateKeywordStatus(id, body.status, articleId);
  return json({ id, status: body.status, article_id: articleId });
};

export const DELETE: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return fail(400, 'リクエストの形式が不正です');

  const id = parseId(body.id);
  if (id === null) return fail(400, 'IDが不正です');

  await deleteKeyword(id);
  return json({ id, deleted: true });
};
