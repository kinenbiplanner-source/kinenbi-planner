/**
 * 記事の新規作成 API（POST /api/articles）。
 *
 * 更新側（src/pages/api/articles/[id].ts）と検証・整形のロジックが丸ごと同じなので、
 * ここに置いて向こうから import している。lib へ切り出さないのは、
 * 「記事保存の入口は /api/articles だけ」という関係をファイル配置で示したいのと、
 * このバリデーションが DB スキーマではなく管理画面フォームの都合だから。
 *
 * 認証は src/middleware.ts が担当する。Cloudflare Access のパスポリシーは
 * /admin にしか掛かっていないので、この API に素の POST が飛んでくる前提で書く
 * （＝入力は全部サーバ側で検証する。クライアント側の検証は体験のためのおまけ）。
 */
import type { APIRoute } from 'astro';
import {
  insertArticle,
  slugStatusMap,
  slugTaken,
  syncKeywordForArticle,
  type ArticleInput,
} from '../../lib/db';
import { isPlaceholderSlug, isValidSlug, makePlaceholderSlug } from '../../lib/frontmatter';
import { isAxisSlug, isFunnel } from '../../lib/axis';
import { renderArticle } from '../../lib/markdown';
/**
 * 公開前の品質チェック。判定そのものは lib/quality.ts に置いてある——
 * 同じ関数をエディタのチェックパネルも呼ぶので、「画面では何も出ないのに
 * 公開したら警告が出る」という食い違いが起きない。
 */
import { inspectArticle, warningsFrom } from '../../lib/quality';

export const prerender = false;

/** 管理画面の操作結果はキャッシュさせない。中間キャッシュにも残さない。 */
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
} as const;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * hero_image は R2 のキーをそのまま持つ。
 * /media/img/<key> にそのまま連結されるので、絶対パス化やディレクトリ遡上を潰しておく。
 */
function normalizeHeroImage(v: unknown): string | null {
  const s = str(v).replace(/^\/+/, '');
  if (!s) return null;
  if (s.includes('..')) return null;
  return s;
}

export type BuildOutcome =
  | { ok: true; input: ArticleInput; warnings: string[] }
  | { ok: false; status: number; message: string };

/**
 * フォーム／API から来た生の JSON を ArticleInput に落とす。
 *
 * `exceptId` は更新時の自分自身（slug 重複チェックから除外する）。
 * `currentPublishedAt` は更新時の DB の現在値。
 */
export async function buildArticleInput(
  raw: Record<string, unknown>,
  opts: { exceptId?: number; currentPublishedAt?: string | null } = {},
): Promise<BuildOutcome> {
  const status = str(raw.status);
  if (status !== 'draft' && status !== 'published') {
    return { ok: false, status: 400, message: 'ステータスは draft か published のみです' };
  }

  /*
   * slug は公開URLそのものなので自動生成しない（公開後に変えると301が要る）。
   * ただし「下書きの間はまだ決めていない」は普通に起きる——書き上がった記事を
   * ひとまず置いておく（一時保存）のに slug を先に決めさせる理由が無い。
   * 空で来たら仮の値を割り当て、公開のときだけ本物を必ず要求する。
   */
  let slug = str(raw.slug);
  if (!slug && status === 'draft') slug = makePlaceholderSlug();

  if (status === 'published' && (!slug || isPlaceholderSlug(slug))) {
    return {
      ok: false,
      status: 400,
      message: '公開する前に slug を決めてください（下書きのままなら slug は空でも保存できます）',
    };
  }
  if (!isValidSlug(slug)) {
    return {
      ok: false,
      status: 400,
      message: 'slug は半角英数とハイフンのみ（先頭・末尾はハイフン不可、80字以内）で入力してください',
    };
  }

  if (await slugTaken(slug, opts.exceptId)) {
    return { ok: false, status: 409, message: `slug「${slug}」は既に使われています` };
  }

  const axis = str(raw.axis);
  if (!isAxisSlug(axis)) return { ok: false, status: 400, message: '軸の指定が不正です' };

  const funnel = str(raw.funnel);
  if (!isFunnel(funnel)) return { ok: false, status: 400, message: 'ファネル層の指定が不正です' };

  const title = str(raw.title);
  const description = str(raw.description);
  const keyword = str(raw.keyword);
  // 本文は trim すると末尾の改行が消えるだけなので trim して良いが、
  // インデントを持つコードブロックを壊さないよう前後の空白行だけ落とす。
  const bodyMd = typeof raw.body_md === 'string' ? raw.body_md.replace(/^\s+|\s+$/g, '') : '';

  const missing: string[] = [];
  if (!title) missing.push('タイトル');
  if (!description) missing.push('ディスクリプション');
  if (!keyword) missing.push('キーワード');
  if (!bodyMd) missing.push('本文');
  if (missing.length) {
    return { ok: false, status: 400, message: `${missing.join('・')}が空です` };
  }

  const rendered = renderArticle(bodyMd);

  // 公開のときだけ品質チェック。ここは「止めずに知らせる」方針にしている。
  // 画像の差し替え漏れ・description の字数・内部リンクの飛び先などは、
  // 公開を止めるほどではないが見落とすと確実に損をする類なので、
  // 保存はさせた上で必ず画面に出す。
  const warnings =
    status === 'published'
      ? warningsFrom(
          inspectArticle({
            title,
            description,
            keyword,
            axis,
            body_md: bodyMd,
            // 内部リンクの飛び先が実在するかを見るために slug の一覧を渡す
            // （style-guide 11章：URLを推測・生成しない）。
            slugStatus: await slugStatusMap(),
          }),
        )
      : [];

  // 公開日は「最初に公開した日」。下書きに戻しても消さず、再公開でも上書きしない。
  // ここを毎回 now にすると、誤字修正で公開し直しただけで記事の日付が飛んでしまう。
  const publishedAt =
    opts.currentPublishedAt ?? (status === 'published' ? new Date().toISOString() : null);

  return {
    ok: true,
    warnings,
    input: {
      slug,
      title,
      description,
      keyword,
      axis,
      funnel,
      status,
      body_md: bodyMd,
      body_html: rendered.html,
      toc_json: JSON.stringify(rendered.toc),
      hero_image: normalizeHeroImage(raw.hero_image),
      is_ad: raw.is_ad ? 1 : 0,
      published_at: publishedAt,
    },
  };
}

/** リクエストボディを JSON として読む。壊れていたら null。 */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const data = await request.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await readJson(request);
  if (!raw) return fail(400, 'リクエストの形式が不正です');

  const built = await buildArticleInput(raw);
  if (!built.ok) return fail(built.status, built.message);

  const id = await insertArticle(built.input);
  const keyword = await syncKeywordForArticle(built.input.keyword, id, built.input.status);
  return json({ id, warnings: built.warnings, keyword }, 201);
};
