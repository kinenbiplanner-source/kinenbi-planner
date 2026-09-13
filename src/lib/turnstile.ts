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

/**
 * Turnstile のキーの形。サイトキーも秘密鍵も `0x4AAAA…`（本番）か `1x0000…`（テスト用）で始まる英数字。
 *
 * **形が合わないキーは「未設定」と同じに扱う。** 2026-09-13、ターミナルで Ctrl+V が貼り付けにならず
 * 制御文字（Ctrl+V ＝ \x16）1文字だけが secret に入った。画面のウィジェットは壊れたサイトキーで描画されず、
 * サーバは「両方入っている」と見て検証を必須にしたので、**申し込みが1件も通らなくなった**。
 * 保存前に弾くので case_log にも残らない。壊れたキーで bot 対策を効かせるより、フォームを止めないほうを取る。
 */
const KEY_RE = /^[0-9]x[0-9A-Za-z_-]{10,}$/;

function readKey(name: 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'): string {
  const key = readVar(name);
  if (key && !KEY_RE.test(key)) {
    // 値そのものは出さない（秘密鍵のことがある）。長さだけで「何か入っているが壊れている」は分かる。
    console.error(`[turnstile] ${name} の形が不正（長さ ${key.length}）。Turnstile を無効として扱う`);
    return '';
  }
  return key;
}

/** 画面に埋めるサイトキー。形が不正なら空文字。 */
export function turnstileSiteKey(): string {
  return readKey('TURNSTILE_SITE_KEY');
}

/**
 * サイトキーと秘密鍵が**両方、正しい形で**入っているか。
 * 画面（apply.astro のウィジェット描画）とサーバ（/api/apply の検証）は必ずこれで揃える。
 * 片方だけ見ると「ウィジェットが無いのにトークン必須」が起きて申し込みが全部落ちる。
 */
export function turnstileConfigured(): boolean {
  return turnstileSiteKey() !== '' && readKey('TURNSTILE_SECRET_KEY') !== '';
}

export interface TurnstileResult {
  ok: boolean;
  /** 秘密鍵が未設定、または検証サーバに届かず判定できなかった */
  skipped?: boolean;
}

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
  const secret = readKey('TURNSTILE_SECRET_KEY');
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
