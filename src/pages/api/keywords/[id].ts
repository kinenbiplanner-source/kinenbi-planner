/**
 * キーワード台帳1件の更新（/api/keywords/[id]）。/admin/keywords/[id] の編集フォームが叩く。
 *
 *   PUT … KeywordEditable の部分更新（渡された列だけ書き換える）
 *
 * /api/keywords（POST＝一括取り込み・PATCH＝ステータス・DELETE）とは口を分けてある。
 * あちらの PATCH は「記事化の進捗」専用で、status と article_id しか触らない。
 * SEO 列（要塞度・検索数・調査日）は /anniv-pick-keyword が入れた数字を人が直す用途で、
 * 取り込みの上書きと混ぜると「どっちが勝ったか」が追えなくなるので、別の口にしている。
 * keyword（主キー相当）と status（台帳画面のセレクトで変える）はここでは受けない。
 *
 * 認証は src/middleware.ts（Cloudflare Access の JWT 検証）が担当する。
 * /admin にしか Access のパスポリシーが掛かっていない以上、この API には素のリクエストが
 * 飛んでくる前提で書く＝入力は全部ここで検証する。1つでも不正なら 400 で何も書かない。
 *
 * json / fail / readJson は /api/keywords と同じものを小さく複製している
 * （`keywords.ts` から import すると角括弧付きパスの兄弟を参照することになり、
 *   /api/cases/[id].ts と同じ理由で確実な方を取った）。
 */
import type { APIRoute } from 'astro';
import { getKeyword, updateKeywordFields, type KeywordEditable } from '../../../lib/db';
import { isAxisSlug, isFunnel } from '../../../lib/axis';

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
    const data = (await request.json()) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** schema.sql の keywords.volume_source / serp_grade と対。keyword-selection.md 2章・4章の語彙。 */
const VOLUME_SOURCES = ['', 'ahrefs', 'csv', 'gsc'] as const;
const SERP_GRADES = ['', 'A', 'B', 'C'] as const;

/** 自由記述の上限。note / serp_note は「上位10の内訳と根拠」を数行書く前提で 2000 字。 */
const LONG_TEXT_MAX = 2000;
/** それ以外の文字列列（検索意図・想定読者・種KW・目安）。1行の想定なので短めに切る。 */
const SHORT_TEXT_MAX = 500;

type Outcome = { ok: true; patch: Partial<KeywordEditable> } | { ok: false; message: string };

/**
 * 「空で null」を受ける整数列。フォームの number 入力は空のとき '' で来るので、
 * null / undefined / '' はすべて null（＝測っていない）に寄せる。
 * 数字は number でも数字文字列でも受ける（手で書いた JSON への配慮は /api/keywords の priority と同じ）。
 */
function intOrNull(v: unknown, label: string, max: number | null): { ok: true; value: number | null } | { ok: false; message: string } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) return { ok: false, message: `${label} は 0 以上の整数か空です` };
  if (max !== null && n > max) return { ok: false, message: `${label} は 0〜${max} です` };
  return { ok: true, value: n };
}

function text(v: unknown, label: string, max: number): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof v !== 'string') return { ok: false, message: `${label} は文字列です` };
  const s = v.trim();
  if (s.length > max) return { ok: false, message: `${label} は ${max} 字までです（${s.length} 字）` };
  return { ok: true, value: s };
}

/** YYYY-MM-DD で、しかも実在する日付か（2026-02-30 のような値を弾く）。 */
function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 受け取った JSON を KeywordEditable の部分集合に落とす。
 * 知らないキーは黙って捨てずに 400 にする——keyword や status を送ってしまった
 * （＝別の口を使うべき）ことに、その場で気付けるように。
 */
function buildPatch(raw: Record<string, unknown>): Outcome {
  const patch: Partial<KeywordEditable> = {};

  for (const [key, v] of Object.entries(raw)) {
    switch (key) {
      case 'axis': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!isAxisSlug(s)) return { ok: false, message: 'axis は gift / date / concierge のいずれかです' };
        patch.axis = s;
        break;
      }
      case 'funnel': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!isFunnel(s)) return { ok: false, message: 'funnel は 集客 / 比較・検討 / 課題解決 のいずれかです' };
        patch.funnel = s;
        break;
      }
      case 'priority': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 3) return { ok: false, message: 'priority は 1〜3 の整数です' };
        patch.priority = n;
        break;
      }
      case 'difficulty':
      case 'volume':
      case 'intent':
      case 'persona':
      case 'seed': {
        const r = text(v, key, SHORT_TEXT_MAX);
        if (!r.ok) return r;
        patch[key] = r.value;
        break;
      }
      case 'note':
      case 'serp_note': {
        const r = text(v, key, LONG_TEXT_MAX);
        if (!r.ok) return r;
        patch[key] = r.value;
        break;
      }
      case 'volume_num': {
        const r = intOrNull(v, 'volume_num（検索数）', null);
        if (!r.ok) return r;
        patch.volume_num = r.value;
        break;
      }
      case 'demand_score': {
        const r = intOrNull(v, 'demand_score（需要スコア）', 100);
        if (!r.ok) return r;
        patch.demand_score = r.value;
        break;
      }
      case 'kd': {
        const r = intOrNull(v, 'kd', 100);
        if (!r.ok) return r;
        patch.kd = r.value;
        break;
      }
      case 'volume_source': {
        const s = typeof v === 'string' ? v.trim() : v === null ? '' : null;
        if (s === null || !(VOLUME_SOURCES as readonly string[]).includes(s)) {
          return { ok: false, message: 'volume_source は ahrefs / csv / gsc か空です' };
        }
        patch.volume_source = s;
        break;
      }
      case 'serp_grade': {
        const s = typeof v === 'string' ? v.trim() : v === null ? '' : null;
        if (s === null || !(SERP_GRADES as readonly string[]).includes(s)) {
          return { ok: false, message: 'serp_grade（要塞度）は A / B / C か空です' };
        }
        patch.serp_grade = s;
        break;
      }
      case 'researched_at': {
        const s = typeof v === 'string' ? v.trim() : v === null ? '' : null;
        if (s === null || (s !== '' && !isYmd(s))) {
          return { ok: false, message: 'researched_at（調査日）は YYYY-MM-DD か空です' };
        }
        patch.researched_at = s;
        break;
      }
      default:
        return { ok: false, message: `${key} はこの口では更新できません（keyword / status は台帳画面から）` };
    }
  }

  return { ok: true, patch };
}

export const PUT: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const raw = await readJson(request);
  if (!raw) return fail(400, 'リクエストの形式が不正です');

  const built = buildPatch(raw);
  if (!built.ok) return fail(400, built.message);
  if (Object.keys(built.patch).length === 0) return fail(400, '更新する項目がありません');

  // 存在確認を書き込みの前に置く。UPDATE は行が無くても成功扱いになるので、
  // 消えた id に保存して「保存できた」と出るのを避ける。
  const before = await getKeyword(id);
  if (!before) return fail(404, 'キーワードが見つかりません');

  await updateKeywordFields(id, built.patch);
  const after = await getKeyword(id);
  return json({ ok: true, keyword: after });
};
