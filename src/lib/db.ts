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

/* ────────────────────────────────────────────────
 * ダッシュボード（/admin/stats）用の集計
 *
 * 画面側で使う形（日付の穴埋め・期間比較・スパークライン）への加工は
 * src/lib/stats.ts が持つ。ここは「DBから何を引くか」だけに絞る。
 * ──────────────────────────────────────────────── */

/** 日別のPV合計（グラフ用）。since 以降のある日だけが返るので、穴埋めは呼び出し側で行う。 */
export async function pvDailyTotals(sinceYmd: string): Promise<Array<{ ymd: string; n: number }>> {
  const { results } = await db()
    .prepare(
      `SELECT ymd, SUM(count) AS n FROM pageviews
       WHERE ymd >= ? GROUP BY ymd ORDER BY ymd ASC`,
    )
    .bind(sinceYmd)
    .all<{ ymd: string; n: number }>();
  return results ?? [];
}

/**
 * since 以降のPVを記事×日のまま返す。
 * 期間比較（直近28日 vs その前28日）とスパークラインの両方で使うので、
 * 集計せずに素のまま渡して stats.ts 側で好きに畳む。
 * 行数は 記事数 × 日数 なので、記事が数百本になったら期間を切るか
 * SQL 側で畳むこと。立ち上げ期の規模では取り回しの良さを優先する。
 */
export async function pvSince(sinceYmd: string): Promise<Array<{ article_id: number; ymd: string; count: number }>> {
  const { results } = await db()
    .prepare(
      `SELECT article_id, ymd, count FROM pageviews
       WHERE ymd >= ? ORDER BY ymd ASC`,
    )
    .bind(sinceYmd)
    .all<{ article_id: number; ymd: string; count: number }>();
  return results ?? [];
}

/**
 * PVを最初に記録した日。null なら1件も計測できていない。
 *
 * 「PVが少ない＝伸びていない」と判定してよいのは、計測がその期間ずっと動いていた場合だけ。
 * 計測を始めた直後は、古い記事ほど不当に「伸び悩み」に見えてしまうので、
 * ダッシュボード側でこの日付を見て判定を保留する。
 */
export async function pvFirstYmd(): Promise<string | null> {
  const row = await db().prepare('SELECT MIN(ymd) AS ymd FROM pageviews').first<{ ymd: string | null }>();
  return row?.ymd ?? null;
}

// ────────────────────────────────────────────────
// 導線のイベント（schema.sql の event_daily）。
// 正規化は受け口（src/pages/api/ev.ts）の責任で、ここは受け取った値をそのまま畳む。

/** イベント1件ぶんの記録。日付×イベント×場所×流入元で1行に加算する。 */
export interface EventKey {
  name: string;
  label: string;
  source: string;
  medium: string;
  campaign: string;
}

export async function recordEvent(e: EventKey): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO event_daily (ymd, name, label, source, medium, campaign, count)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(ymd, name, label, source, medium, campaign) DO UPDATE SET count = count + 1`,
    )
    .bind(jstYmd(), e.name, e.label, e.source, e.medium, e.campaign)
    .run();
}

export interface EventRow extends EventKey {
  ymd: string;
  count: number;
}

/** 指定日以降の生の行。ダッシュボード側で好きに畳めるよう、集計せずに返す。 */
export async function eventsSince(sinceYmd: string): Promise<EventRow[]> {
  const { results } = await db()
    .prepare(
      `SELECT ymd, name, label, source, medium, campaign, count
       FROM event_daily WHERE ymd >= ? ORDER BY ymd`,
    )
    .bind(sinceYmd)
    .all<EventRow>();
  return results ?? [];
}

/**
 * 計測を最初に記録した日。null なら1件も取れていない。
 * pvFirstYmd と同じ理由で要る（計測開始前の期間を「ゼロ」と読ませないため）。
 */
export async function eventFirstYmd(): Promise<string | null> {
  const row = await db().prepare('SELECT MIN(ymd) AS ymd FROM event_daily').first<{ ymd: string | null }>();
  return row?.ymd ?? null;
}

/**
 * KW台帳の件数を 軸 × ステータス × 優先度 で刻んで返す。
 * この3つの組み合わせがあれば「軸1の未着手が何本」「優先度1の残りが何本」を
 * 画面側で足すだけで出せるので、集計のたびにクエリを増やさずに済む。
 */
export async function countKeywordsGrouped(): Promise<
  Array<{ axis: string; status: string; priority: number; n: number }>
> {
  const { results } = await db()
    .prepare('SELECT axis, status, priority, COUNT(*) AS n FROM keywords GROUP BY axis, status, priority')
    .all<{ axis: string; status: string; priority: number; n: number }>();
  return results ?? [];
}

/* ────────────────────────────────────────────────
 * 記事エディタ（/admin/new・/admin/[id]/edit）用
 * ──────────────────────────────────────────────── */

export interface SlugIndexRow {
  id: number;
  slug: string;
  title: string;
  axis: string;
  status: 'draft' | 'published';
}

/**
 * 全記事の slug 一覧（下書きも含む）。
 *
 * エディタでは3つの用途に使う：
 *   1. slug の重複を保存前に知らせる（今までは保存して409で初めて分かった）
 *   2. 内部リンクの挿入候補（style-guide 11章：URLを推測・生成しない）
 *   3. 本文中の /media/<slug> が実在するかの確認
 * 立ち上げ期の記事数を前提に全件引く。数百本になったら候補側にLIMITを入れる。
 */
export async function listSlugIndex(): Promise<SlugIndexRow[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, slug, title, axis, status FROM articles
       ORDER BY COALESCE(published_at, updated_at) DESC, id DESC LIMIT 500`,
    )
    .all<SlugIndexRow>();
  return results ?? [];
}

/** slug → 状態。/api/articles の公開前チェック（内部リンクの実在確認）で使う。 */
export async function slugStatusMap(): Promise<Record<string, 'published' | 'draft'>> {
  const { results } = await db()
    .prepare('SELECT slug, status FROM articles')
    .all<{ slug: string; status: 'published' | 'draft' }>();
  return Object.fromEntries((results ?? []).map((r) => [r.slug, r.status]));
}

/** エディタのKW候補。台帳の全列は要らないので判断に使う列だけ引く。 */
export type KeywordChoice = Pick<
  KeywordRow,
  'id' | 'keyword' | 'axis' | 'funnel' | 'difficulty' | 'volume' | 'priority' | 'status' | 'article_id'
>;

export async function listKeywordChoices(): Promise<KeywordChoice[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, keyword, axis, funnel, difficulty, volume, priority, status, article_id
       FROM keywords WHERE status <> 'dropped' ORDER BY priority ASC, id ASC`,
    )
    .all<KeywordChoice>();
  return results ?? [];
}

/**
 * 記事の保存に合わせてキーワード台帳を追従させる。
 *
 * これまでは記事を公開したあと /admin/keywords で手動で「記事化済み」に倒していた。
 * 手作業だと必ず抜けるうえ、抜けると台帳の「在庫」が実態とズレて着手順の判断が狂う。
 * 記事の keyword 列と台帳の keyword は完全一致で突き合わせる（表記ゆれは寄せない。
 * 曖昧一致で別のKWを勝手に消化済みにする方が害が大きい）。
 *
 * 戻り値は画面に出す文言のための情報。該当が無ければ null。
 */
export async function syncKeywordForArticle(
  keyword: string,
  articleId: number,
  articleStatus: 'draft' | 'published',
): Promise<{ keyword: string; status: KeywordRow['status']; changed: boolean } | null> {
  const row = await db()
    .prepare('SELECT id, status, article_id FROM keywords WHERE keyword=?')
    .bind(keyword)
    .first<{ id: number; status: KeywordRow['status']; article_id: number | null }>();
  if (!row) return null;

  // 公開＝記事化済み。下書き保存は「着手した」までしか言えないので writing 止まり。
  // dropped（見送り）に倒したKWを保存のたびに復活させないよう、そこだけは触らない。
  const next: KeywordRow['status'] =
    articleStatus === 'published' ? 'done' : row.status === 'todo' ? 'writing' : row.status;
  if (row.status === 'dropped') return null;
  // 変化が無いときも「台帳と繋がっている」ことは返す（changed:false）。
  // 画面はここを見て文言を変える——毎回「〜にした」と出ると、
  // 実際には何も動いていないのに動いたように読めてしまう。
  if (next === row.status && row.article_id === articleId) {
    return { keyword, status: row.status, changed: false };
  }

  await updateKeywordStatus(row.id, next, articleId);
  return { keyword, status: next, changed: true };
}
