/**
 * D1（記事テーブル）へのアクセス。スキーマは schema.sql が正。
 *
 * バインディングは wrangler.jsonc で定義し、`cloudflare:workers` の env から取る。
 * Astro 5 以降は Astro.locals.runtime.env ではなくこちらが正式な経路。
 */
import { env } from 'cloudflare:workers';

export interface ArticleRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  keyword: string;
  axis: string;
  funnel: string;
  status: 'draft' | 'published';
  body_md: string;
  body_html: string;
  toc_json: string;
  hero_image: string | null;
  is_ad: number;
  published_at: string | null;
  updated_at: string;
  created_at: string;
}

/** 一覧・カード表示で本文まで引くと無駄なので、必要な列だけの型も用意する。 */
export type ArticleCard = Pick<
  ArticleRow,
  'id' | 'slug' | 'title' | 'description' | 'axis' | 'funnel' | 'hero_image' | 'published_at'
>;

const CARD_COLS = 'id, slug, title, description, axis, funnel, hero_image, published_at';

export function db(): D1Database {
  return env.DB;
}

export const PAGE_SIZE = 12;

/** 公開記事を新しい順に。axis を渡すとその軸だけに絞る。 */
export async function listPublished(
  opts: { axis?: string; limit?: number; offset?: number } = {},
): Promise<ArticleCard[]> {
  const { axis, limit = PAGE_SIZE, offset = 0 } = opts;
  const sql = axis
    ? `SELECT ${CARD_COLS} FROM articles WHERE status='published' AND axis=?
       ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`
    : `SELECT ${CARD_COLS} FROM articles WHERE status='published'
       ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`;
  const stmt = axis
    ? db().prepare(sql).bind(axis, limit, offset)
    : db().prepare(sql).bind(limit, offset);
  const { results } = await stmt.all<ArticleCard>();
  return results ?? [];
}

export async function countPublished(axis?: string): Promise<number> {
  const sql = axis
    ? "SELECT COUNT(*) AS n FROM articles WHERE status='published' AND axis=?"
    : "SELECT COUNT(*) AS n FROM articles WHERE status='published'";
  const stmt = axis ? db().prepare(sql).bind(axis) : db().prepare(sql);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

/** 記事詳細。公開済みのみ（下書きのプレビューは管理画面側の経路で見る）。 */
export async function getPublishedBySlug(slug: string): Promise<ArticleRow | null> {
  return await db()
    .prepare("SELECT * FROM articles WHERE slug=? AND status='published'")
    .bind(slug)
    .first<ArticleRow>();
}

/** 関連記事：同じ軸の公開記事から、自分を除いて新しい順に。 */
export async function listRelated(axis: string, excludeId: number, limit = 3): Promise<ArticleCard[]> {
  const { results } = await db()
    .prepare(
      `SELECT ${CARD_COLS} FROM articles
       WHERE status='published' AND axis=? AND id<>?
       ORDER BY published_at DESC, id DESC LIMIT ?`,
    )
    .bind(axis, excludeId, limit)
    .all<ArticleCard>();
  return results ?? [];
}

/** sitemap / RSS 用。全公開記事を新しい順に。 */
export async function listAllPublished(): Promise<
  Array<Pick<ArticleRow, 'slug' | 'title' | 'description' | 'published_at' | 'updated_at'>>
> {
  const { results } = await db()
    .prepare(
      `SELECT slug, title, description, published_at, updated_at FROM articles
       WHERE status='published' ORDER BY published_at DESC, id DESC`,
    )
    .all<Pick<ArticleRow, 'slug' | 'title' | 'description' | 'published_at' | 'updated_at'>>();
  return results ?? [];
}

/* ── 管理画面用（下書きも含む）── */

export async function listForAdmin(): Promise<
  Array<Pick<ArticleRow, 'id' | 'slug' | 'title' | 'axis' | 'funnel' | 'status' | 'published_at' | 'updated_at'>>
> {
  const { results } = await db()
    .prepare(
      `SELECT id, slug, title, axis, funnel, status, published_at, updated_at FROM articles
       ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
    )
    .all<Pick<ArticleRow, 'id' | 'slug' | 'title' | 'axis' | 'funnel' | 'status' | 'published_at' | 'updated_at'>>();
  return results ?? [];
}

export async function getById(id: number): Promise<ArticleRow | null> {
  return await db().prepare('SELECT * FROM articles WHERE id=?').bind(id).first<ArticleRow>();
}

export async function slugTaken(slug: string, exceptId?: number): Promise<boolean> {
  const row = exceptId
    ? await db().prepare('SELECT id FROM articles WHERE slug=? AND id<>?').bind(slug, exceptId).first()
    : await db().prepare('SELECT id FROM articles WHERE slug=?').bind(slug).first();
  return row !== null;
}

export interface ArticleInput {
  slug: string;
  title: string;
  description: string;
  keyword: string;
  axis: string;
  funnel: string;
  status: 'draft' | 'published';
  body_md: string;
  body_html: string;
  toc_json: string;
  hero_image: string | null;
  is_ad: number;
  /** 公開に切り替えた時だけ入る。既に公開済みなら元の日付を保つ。 */
  published_at: string | null;
}

export async function insertArticle(a: ArticleInput): Promise<number> {
  const now = new Date().toISOString();
  const res = await db()
    .prepare(
      `INSERT INTO articles
       (slug,title,description,keyword,axis,funnel,status,body_md,body_html,toc_json,hero_image,is_ad,published_at,updated_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      a.slug, a.title, a.description, a.keyword, a.axis, a.funnel, a.status,
      a.body_md, a.body_html, a.toc_json, a.hero_image, a.is_ad, a.published_at, now, now,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function updateArticle(id: number, a: ArticleInput): Promise<void> {
  await db()
    .prepare(
      `UPDATE articles SET
       slug=?,title=?,description=?,keyword=?,axis=?,funnel=?,status=?,
       body_md=?,body_html=?,toc_json=?,hero_image=?,is_ad=?,published_at=?,updated_at=?
       WHERE id=?`,
    )
    .bind(
      a.slug, a.title, a.description, a.keyword, a.axis, a.funnel, a.status,
      a.body_md, a.body_html, a.toc_json, a.hero_image, a.is_ad, a.published_at,
      new Date().toISOString(), id,
    )
    .run();
}

export async function deleteArticle(id: number): Promise<void> {
  await db().prepare('DELETE FROM articles WHERE id=?').bind(id).run();
}

/* ────────────────────────────────────────────────
 * PV（pageviews テーブル）
 * ──────────────────────────────────────────────── */

/** JSTの YYYY-MM-DD。WorkerはUTCで動くので +9h してから切り出す。 */
export function jstYmd(d: Date = new Date()): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * PVを1加算する。記事ページはエッジで60秒キャッシュされるため、
 * ページ生成時ではなくクライアントのビーコンから呼ぶ（POST /api/pv）。
 */
export async function recordPageview(articleId: number): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO pageviews (article_id, ymd, count) VALUES (?, ?, 1)
       ON CONFLICT(article_id, ymd) DO UPDATE SET count = count + 1`,
    )
    .bind(articleId, jstYmd())
    .run();
}

/** 記事ごとの累計PV。管理画面の一覧で使う。 */
export async function pvTotals(): Promise<Map<number, number>> {
  const { results } = await db()
    .prepare('SELECT article_id, SUM(count) AS n FROM pageviews GROUP BY article_id')
    .all<{ article_id: number; n: number }>();
  return new Map((results ?? []).map((r) => [r.article_id, r.n]));
}

/** 直近N日のPVが多い公開記事。メディアTOPの「人気の記事」に使う。 */
export async function listPopular(days = 30, limit = 5): Promise<Array<ArticleCard & { pv: number }>> {
  const since = jstYmd(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const { results } = await db()
    .prepare(
      `SELECT a.id, a.slug, a.title, a.description, a.axis, a.funnel, a.hero_image, a.published_at,
              COALESCE(SUM(p.count), 0) AS pv
       FROM articles a
       LEFT JOIN pageviews p ON p.article_id = a.id AND p.ymd >= ?
       WHERE a.status='published'
       GROUP BY a.id
       ORDER BY pv DESC, a.published_at DESC
       LIMIT ?`,
    )
    .bind(since, limit)
    .all<ArticleCard & { pv: number }>();
  return results ?? [];
}

/* ────────────────────────────────────────────────
 * キーワード台帳（keywords テーブル）
 * ──────────────────────────────────────────────── */

export interface KeywordRow {
  id: number;
  keyword: string;
  axis: string;
  funnel: string;
  intent: string;
  persona: string;
  difficulty: string;
  volume: string;
  priority: number;
  status: 'todo' | 'writing' | 'done' | 'dropped';
  article_id: number | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export type KeywordInput = Omit<KeywordRow, 'id' | 'created_at' | 'updated_at'>;

export async function listKeywords(opts: { axis?: string; status?: string } = {}): Promise<KeywordRow[]> {
  const where: string[] = [];
  const bind: unknown[] = [];
  if (opts.axis) { where.push('axis = ?'); bind.push(opts.axis); }
  if (opts.status) { where.push('status = ?'); bind.push(opts.status); }
  const sql = `SELECT * FROM keywords${where.length ? ' WHERE ' + where.join(' AND ') : ''}
               ORDER BY priority ASC, axis ASC, id ASC`;
  const stmt = bind.length ? db().prepare(sql).bind(...bind) : db().prepare(sql);
  const { results } = await stmt.all<KeywordRow>();
  return results ?? [];
}

export async function countKeywordsByStatus(): Promise<Record<string, number>> {
  const { results } = await db()
    .prepare('SELECT status, COUNT(*) AS n FROM keywords GROUP BY status')
    .all<{ status: string; n: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.status, r.n]));
}

/** キーワードを1件追加。keyword が重複したら既存を更新する（リサーチの再取り込み用）。 */
export async function upsertKeyword(k: KeywordInput): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO keywords
       (keyword,axis,funnel,intent,persona,difficulty,volume,priority,status,article_id,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(keyword) DO UPDATE SET
         axis=excluded.axis, funnel=excluded.funnel, intent=excluded.intent,
         persona=excluded.persona, difficulty=excluded.difficulty, volume=excluded.volume,
         priority=excluded.priority, note=excluded.note, updated_at=excluded.updated_at`,
    )
    .bind(
      k.keyword, k.axis, k.funnel, k.intent, k.persona, k.difficulty, k.volume,
      k.priority, k.status, k.article_id, k.note, now, now,
    )
    .run();
}

export async function updateKeywordStatus(
  id: number,
  status: KeywordRow['status'],
  articleId: number | null = null,
): Promise<void> {
  await db()
    .prepare('UPDATE keywords SET status=?, article_id=?, updated_at=? WHERE id=?')
    .bind(status, articleId, new Date().toISOString(), id)
    .run();
}

export async function deleteKeyword(id: number): Promise<void> {
  await db().prepare('DELETE FROM keywords WHERE id=?').bind(id).run();
}
