/**
 * Cloudflare Turnstile のサーバ側検証。
 *
 * 申込フォーム（/apply・/contact）が widget のトークンを `cf-turnstile-response` で送ってくるので、
 * /api/apply が保存前にここで確かめる。ハニーポット（intake.ts の website 欄）だけだと
 * 素直な bot しか弾けないため、その上に載せる。
 *
 * TURNSTILE_SECRET_KEY が未設定なら { ok:true, skipped:true } で通す。
 * まだ Turnstile を設定していない段階でフォームを止めないため（設定したら自動で効き始める）。
 */
import { readVar } from './config';

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  ok: boolean;
  /** 秘密鍵が未設定、または検証サーバに届かず判定できなかった */
  skipped?: boolean;
}

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
  const secret = readVar('TURNSTILE_SECRET_KEY');
  if (!secret) return { ok: true, skipped: true };

  // 秘密鍵があるのにトークンが無い＝widget を通っていない（bot か、画面側の組み込み漏れ）。
  if (!token) return { ok: false };

  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'local') body.set('remoteip', ip);

  try {
    const res = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      // 検証サーバ側の障害。bot を1件通すより本物の申込を落とす方が損なので通す。
      console.error(`[turnstile] siteverify が ${res.status} を返した`);
      return { ok: true, skipped: true };
    }
    const data = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (data.success === true) return { ok: true };
    console.warn('[turnstile] 検証 NG', data['error-codes']);
    return { ok: false };
  } catch (e) {
    console.error('[turnstile] siteverify に届かなかった', e);
    return { ok: true, skipped: true };
  }
}
