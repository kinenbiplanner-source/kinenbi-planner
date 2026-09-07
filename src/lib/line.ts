/**
 * LINE 公式アカウントの友だち・メッセージ（line_users / line_messages）への D1 アクセスと、
 * サンクスページ用の URL 生成。
 *
 * Messaging API の呼び出し（署名検証・プロフィール取得・push・reply）は src/lib/line-api.ts。
 * こちらは DB だけ。管理画面はこのファイルだけ読めば「誰が友だち追加したか」を出せる。
 */
import { db } from './db';
import { lineAddUrl, lineOaId } from './config';

export interface LineUserRow {
  user_id: string;
  display_name: string;
  picture_url: string;
  followed_at: string;
  unfollowed_at: string | null;
  last_message_at: string | null;
  updated_at: string;
}

/** 一覧用。どの案件に紐づいているかを JOIN で足す。 */
export interface LineUserListItem extends LineUserRow {
  case_id: number | null;
  case_code: string | null;
  case_name: string | null;
}

export interface LineMessageRow {
  id: number;
  user_id: string;
  direction: 'in' | 'out';
  text: string;
  event_at: string;
  raw_json: string;
}

/**
 * follow（友だち追加）で呼ぶ。既に行があれば表示名を更新し、ブロック解除なら unfollowed_at を戻す。
 * followed_at は「最後に追加した日時」にする（ブロック→再追加を追えるように）。
 */
export async function upsertLineUser(
  u: { user_id: string; display_name?: string; picture_url?: string },
  followedAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO line_users (user_id, display_name, picture_url, followed_at, unfollowed_at, updated_at)
       VALUES (?,?,?,?,NULL,?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE line_users.display_name END,
         picture_url  = CASE WHEN excluded.picture_url  <> '' THEN excluded.picture_url  ELSE line_users.picture_url  END,
         followed_at  = CASE WHEN line_users.unfollowed_at IS NOT NULL THEN excluded.followed_at ELSE line_users.followed_at END,
         unfollowed_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(u.user_id, u.display_name ?? '', u.picture_url ?? '', followedAt, now)
    .run();
}

/** プロフィールだけ更新（メッセージ受信時に名前を最新化するとき）。行が無ければ作る。 */
export async function touchLineUser(
  u: { user_id: string; display_name?: string; picture_url?: string },
  at: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO line_users (user_id, display_name, picture_url, followed_at, last_message_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE line_users.display_name END,
         picture_url  = CASE WHEN excluded.picture_url  <> '' THEN excluded.picture_url  ELSE line_users.picture_url  END,
         last_message_at = excluded.last_message_at,
         updated_at = excluded.updated_at`,
    )
    .bind(u.user_id, u.display_name ?? '', u.picture_url ?? '', at, at, now)
    .run();
}

export async function markLineUnfollow(userId: string, at: string): Promise<void> {
  await db()
    .prepare('UPDATE line_users SET unfollowed_at=?, updated_at=? WHERE user_id=?')
    .bind(at, new Date().toISOString(), userId)
    .run();
}

export async function getLineUser(userId: string): Promise<LineUserRow | null> {
  return await db().prepare('SELECT * FROM line_users WHERE user_id=?').bind(userId).first<LineUserRow>();
}

export async function listLineUsers(
  opts: { unlinkedOnly?: boolean; includeUnfollowed?: boolean; limit?: number } = {},
): Promise<LineUserListItem[]> {
  const where: string[] = [];
  if (opts.unlinkedOnly) where.push('c.id IS NULL');
  if (!opts.includeUnfollowed) where.push('u.unfollowed_at IS NULL');
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await db()
    .prepare(
      `SELECT u.*, c.id AS case_id, c.code AS case_code, c.name AS case_name
       FROM line_users u
       LEFT JOIN cases c ON c.line_user_id = u.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.followed_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<LineUserListItem>();
  return results ?? [];
}

export async function countLineUsers(): Promise<{ total: number; unlinked: number }> {
  const row = await db()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN c.id IS NULL THEN 1 ELSE 0 END) AS unlinked
       FROM line_users u LEFT JOIN cases c ON c.line_user_id = u.user_id
       WHERE u.unfollowed_at IS NULL`,
    )
    .first<{ total: number; unlinked: number | null }>();
  return { total: row?.total ?? 0, unlinked: row?.unlinked ?? 0 };
}

export async function recordLineMessage(
  userId: string,
  direction: 'in' | 'out',
  text: string,
  eventAt: string,
  raw: unknown = '',
): Promise<number> {
  let rawJson = '';
  try {
    rawJson = typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 8000);
  } catch {
    rawJson = '';
  }
  const res = await db()
    .prepare('INSERT INTO line_messages (user_id, direction, text, event_at, raw_json) VALUES (?,?,?,?,?)')
    .bind(userId, direction, text.slice(0, 5000), eventAt, rawJson)
    .run();
  return Number(res.meta.last_row_id);
}

/** 新しい順。画面では reverse して時系列に並べる。 */
export async function listLineMessages(userId: string, limit = 50): Promise<LineMessageRow[]> {
  const { results } = await db()
    .prepare('SELECT * FROM line_messages WHERE user_id=? ORDER BY id DESC LIMIT ?')
    .bind(userId, limit)
    .all<LineMessageRow>();
  return results ?? [];
}

/* ── サンクスページ用の URL ── */

/**
 * 「友だち追加してトークに受付番号を送る」を1タップにする URL。
 * LINE 公式アカウントの oaMessage スキーム（@ベーシックID が要る）。
 * ベーシックIDが未設定なら null（呼び出し側は lin.ee の友だち追加URLに落とす）。
 *
 * **`@` はエンコードしない。** LINE の URL スキームは `.../oaMessage/@anniv/?本文` の形で
 * `@` を素のまま書く決まりで、`%40` にすると開かない端末がある。
 * ベーシックIDに使える字は英数と `-` `_` `.` だけなので、
 * それ以外が混じっていたら組み立てずに null を返す（壊れたリンクを出さない）。
 */
export function oaMessageUrl(code: string): string | null {
  const id = lineOaId();
  if (!id || !/^@[A-Za-z0-9._-]+$/.test(id)) return null;
  return `https://line.me/R/oaMessage/${id}/?${encodeURIComponent(`受付番号 ${code}`)}`;
}

export function addFriendUrl(): string {
  return lineAddUrl();
}
