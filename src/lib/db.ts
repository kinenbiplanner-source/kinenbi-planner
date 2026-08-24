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
