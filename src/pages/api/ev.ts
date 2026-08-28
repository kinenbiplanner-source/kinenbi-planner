/**
 * 導線イベントの収集ビーコン（POST /api/ev）。
 *
 * GA4 にも同じ行為を飛ばしているが、**GA4の数字はGA4の画面にしか無い**。
 * /dashboard に出す数字はこちらから引く（schema.sql の event_daily 参照）。
 *
 * `/api/pv` と同じく**認証を掛けられない**（公開ページの読者が叩くため）。
 * src/middleware.ts の PUBLIC_API に `/api/ev` を入れてある。外すと計測が全部止まる。
 *
 * ## 無認証の書き込み口として引き受けている制約
 *
 * `/api/pv` は「既存の公開記事のカウンタを1増やす」だけで、書ける先が有限だった。
 * こちらは**文字列を受けて行を作る**ので、そのままだと `event_daily` の
 * PRIMARY KEY の組み合わせを無限に増やされる（＝行数が青天井）。だから：
 *
 *   1. `name` は許可リストのみ。未知の名前は**行を作らずに捨てる**
 *   2. `label` / `campaign` は `[a-z0-9_-]` に落として32字で切る
 *   3. `source` / `medium` も許可リスト。未知の source は 'other' に畳む
 *   4. 1リクエスト1イベント。ボディは 512 バイトまで
 *   5. 同一IP＋同一イベントの連打は 10 秒まとめて1件
 *
 * 3 の「未知は other」が効いていて、**新しい流入元が増えても行は増えない**。
 * 増やしたいときは下の ALLOWED_SOURCES に足す（＝意図的な操作でしか増えない）。
 *
 * 本気で狙われたら Cloudflare の Rate Limiting Rules で前段に落とす。ここは下限の防御。
 */
import type { APIRoute } from 'astro';
import { recordEvent } from '../../lib/db';

export const prerender = false;

const MAX_BODY_BYTES = 512;

/** 連打の間引き窓。pv より短いのは、1ページで複数のイベントが正当に起きるため。 */
const DEDUPE_MS = 10_000;

/**
 * 記録するイベント名。**計測設計.md 4章の一覧と対**。
 * ここに無い名前は捨てる。新しい導線を足すときは、あちらの表とここの両方に足す。
 */
const ALLOWED_NAMES = new Set([
  'page_view',
  'cta_click',
  'line_add_click',
  'links_click',
  'follow_click',
  'form_complete',
  'form_error',
  'article_feedback',
]);

/**
 * 流入元。**UTMの utm_source に対応**（計測設計.md 7章のリンク設計）。
 * `direct` はUTMも参照元も無い場合、`other` は見覚えのない値が来た場合。
 */
const ALLOWED_SOURCES = new Set([
  'instagram',
  'x',
  'tiktok',
  'line',
  'meta_ads',
  'google',
  'yahoo',
  'bing',
  'other',
  'direct',
]);

/** 置き場所。utm_medium に対応。`organic` は検索から来た場合の推定値。 */
const ALLOWED_MEDIUMS = new Set([
  'profile',
  'story',
  'post',
  'dm',
  'bio',
  'paid',
  'qr',
  'organic',
  'referral',
  '',
]);

/** ラベルとキャンペーンの正規化。組み合わせ爆発を防ぐのが目的なので、強めに削る。 */
function slug(v: unknown, max = 32): string {
  if (typeof v !== 'string') return '';
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, max);
}

function pick(v: unknown, allowed: Set<string>, fallback: string): string {
  const s = slug(v, 16);
  if (allowed.has(s)) return s;
  return fallback;
}

/**
 * 流入元。**「指定が無かった」と「知らない値だった」を混ぜない。**
 * 空なら `direct`（UTMも参照元も無い）、値はあるが許可リストに無ければ `other`。
 * ここを両方 `direct` に倒すと、知らない流入が「直接アクセス」に化けて数字が読めなくなる。
 */
function pickSource(v: unknown): string {
  const s = slug(v, 16);
  if (!s) return 'direct';
  return ALLOWED_SOURCES.has(s) ? s : 'other';
}

const recent = new Map<string, number>();
const DEDUPE_MAX_ENTRIES = 2000;

function seenRecently(key: string, now: number): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < DEDUPE_MS) return true;

  if (recent.size >= DEDUPE_MAX_ENTRIES) {
    for (const [k, t] of recent) {
      if (now - t >= DEDUPE_MS) recent.delete(k);
    }
    if (recent.size >= DEDUPE_MAX_ENTRIES) recent.clear();
  }
  recent.set(key, now);
  return false;
}

function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0]!.trim();
  return 'local';
}

/** 成否を読者に返さない（`/api/pv` と同じ理由）。 */
function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return noContent();

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return noContent();
  }
  if (raw.length > MAX_BODY_BYTES) return noContent();

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return noContent();
    data = parsed as Record<string, unknown>;
  } catch {
    return noContent();
  }

  const name = slug(data.name, 24);
  if (!ALLOWED_NAMES.has(name)) return noContent();

  const label = slug(data.label);
  const source = pickSource(data.source);
  const medium = pick(data.medium, ALLOWED_MEDIUMS, '');
  const campaign = slug(data.campaign);

  const key = `${clientIp(request)}|${name}|${label}`;
  if (seenRecently(key, Date.now())) return noContent();

  try {
    await recordEvent({ name, label, source, medium, campaign });
  } catch {
    // 計測の失敗で読者側に何かを見せる必要はない。落とさず飲む。
  }
  return noContent();
};
