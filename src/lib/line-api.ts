/**
 * LINE Messaging API のクライアント（署名検証・プロフィール取得・push・reply）。
 *
 * DB 側（line_users / line_messages）は src/lib/line.ts。こちらは HTTP だけで D1 に触らない。
 * 呼び出し元は Webhook（src/pages/api/line/webhook.ts）、管理画面の送信 API
 * （src/pages/api/cases/[id]/send.ts）、運営者通知（src/lib/notify.ts）。
 *
 * すべての関数は例外を投げない。LINE 側が落ちていても申込の受付そのものは止めたくないので、
 * 失敗は戻り値の { ok:false, error } で返し、呼び出し側が「送れなかった」を記録して先へ進む。
 *
 * 設定は wrangler secret（src/lib/config.ts の readVar で読む）：
 *   LINE_CHANNEL_SECRET        … Webhook の署名検証。無いと Webhook は全部 401
 *   LINE_CHANNEL_ACCESS_TOKEN  … push / reply / profile（長期チャネルアクセストークン）
 */
import { readVar } from './config';

const API_BASE = 'https://api.line.me/v2/bot';

/** テキストメッセージ1通の上限（Messaging API の仕様）。超えた分は切る。 */
const MAX_TEXT_LENGTH = 5000;

export interface LineApiResult {
  ok: boolean;
  error?: string;
}

export interface LineProfile {
  displayName: string;
  pictureUrl: string;
}

export function lineApiConfigured(): boolean {
  return readVar('LINE_CHANNEL_ACCESS_TOKEN') !== '';
}

function accessToken(): string {
  return readVar('LINE_CHANNEL_ACCESS_TOKEN');
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 定数時間の文字列比較。
 * `===` は先頭から不一致の位置で抜けるので、比較時間から署名を1文字ずつ推測する余地が残る。
 * 長さが違えば即 false でよい（署名の長さは固定なので、そこから漏れる情報は無い）。
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Webhook の署名検証（X-Line-Signature）。
 * channel secret を鍵に**生ボディ**の HMAC-SHA256 を取り、base64 にしたものと比較する
 * （JSON.parse してから stringify し直すと空白が変わって一致しないので、必ず生の文字列を渡す）。
 *
 * **秘密が未設定なら常に false。** 本番で「未設定＝素通し」にすると、誰でも偽の follow / message を
 * 投げて他人の LINE を案件に紐づけられる。開発時の例外は Webhook 側（import.meta.env.DEV）で持つ。
 */
export async function verifyLineSignature(rawBody: string, signature: string | null): Promise<boolean> {
  const secret = readVar('LINE_CHANNEL_SECRET');
  if (!secret || !signature) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    return constantTimeEqual(base64(new Uint8Array(mac)), signature.trim());
  } catch (e) {
    console.error('[line-api] 署名検証で例外', e);
    return false;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * プロフィール取得。ブロック中のユーザーは 404 が返る（友だちでないと取れない仕様）ので、
 * 取れなければ null にして表示名は空のまま進める。
 */
export async function getLineProfile(userId: string): Promise<LineProfile | null> {
  const token = accessToken();
  if (!token || !userId) return null;
  try {
    const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[line-api] profile 取得失敗 ${res.status}`, await safeText(res));
      return null;
    }
    const data = (await res.json()) as { displayName?: unknown; pictureUrl?: unknown };
    return {
      displayName: typeof data.displayName === 'string' ? data.displayName : '',
      pictureUrl: typeof data.pictureUrl === 'string' ? data.pictureUrl : '',
    };
  } catch (e) {
    console.error('[line-api] profile 取得で例外', e);
    return null;
  }
}

function textMessage(text: string): { type: 'text'; text: string } {
  return { type: 'text', text: text.slice(0, MAX_TEXT_LENGTH) };
}

async function postMessages(path: string, payload: Record<string, unknown>): Promise<LineApiResult> {
  const token = accessToken();
  if (!token) return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN が未設定' };
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `LINE API ${res.status}: ${await safeText(res)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** プッシュ送信（管理画面からの返信・運営者通知）。無料枠の通数を消費する。 */
export async function pushText(userId: string, text: string): Promise<LineApiResult> {
  if (!userId) return { ok: false, error: 'userId が空' };
  const body = text.trim();
  if (!body) return { ok: false, error: '本文が空' };
  return postMessages('/message/push', { to: userId, messages: [textMessage(body)] });
}

/**
 * 応答送信（Webhook で受けた replyToken に対して1回だけ）。
 * reply は通数に数えられないので、Webhook 内の自動応答はこちらを使う。
 * replyToken は短時間で失効し再利用もできないため、1イベントで2回呼ばない。
 */
export async function replyText(replyToken: string, text: string): Promise<LineApiResult> {
  if (!replyToken) return { ok: false, error: 'replyToken が空' };
  const body = text.trim();
  if (!body) return { ok: false, error: '本文が空' };
  return postMessages('/message/reply', { replyToken, messages: [textMessage(body)] });
}
