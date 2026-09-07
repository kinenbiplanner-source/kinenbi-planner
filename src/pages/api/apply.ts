/**
 * 申込フォーム（/apply）と無料相談（/contact）の受け口（POST /api/apply）。
 *
 * やることは4つ：
 *   1. 入力を検証する（src/lib/intake.ts の parseIntake。設問と選択肢の SSOT はあちら）
 *   2. D1 に案件を作る（src/lib/cases.ts の createCase。受付番号 code はここで採番される）
 *   3. 顧客へ受付確認メールを送る（LINE の友だち追加導線が主役。src/lib/mail.ts）
 *   4. 運営者へ通知する（メール＋LINE push。src/lib/notify.ts）
 *
 * **申し込みは2段階で、ここは1段目**（2026-09-07）。申込フォームで聞くのは
 * お名前・メール・LINE名の3つだけで、記念日・予算・パートナーの好みは友だち追加のあと
 * `/survey`（受け口は src/pages/api/survey.ts）で受け取り、**同じ行を更新する**。
 * 分けた理由は src/lib/intake.ts の冒頭。
 *
 * **認証を掛けられない公開 API** なので src/middleware.ts の PUBLIC_API に入れてある。
 * その代わり防御は3枚重ねる：
 *   - ハニーポット（intake.ts の website 欄。素直な bot はここで落ちる）
 *   - Cloudflare Turnstile（src/lib/turnstile.ts。秘密鍵が未設定なら素通しで、設定した時点で効き始める）
 *   - 同一IPのレート制限（下の RATE_MAX。/api/ev と同じ in-memory Map 方式）
 *
 * ## 保存とメールの関係
 *
 * **メールが送れなくても受付は成功で返す。** 案件は既に D1 に入っていて管理画面から見えるので、
 * ここで 500 を返すと顧客が同じ内容を何度も送り直す（＝重複案件が増える）方が損。
 * 送れなかった事実は case_log に残して、管理画面で気づけるようにする。
 *
 * ## フォームからの2通りの呼ばれ方
 *
 *   - fetch（JSON）… 応答も JSON。`{ ok, code, redirect }` を見て画面側で遷移する
 *   - 素の <form> ポスト … 303 で /thanks?c=<受付番号> へ飛ばす（JS が動かない環境でも完了する）
 * どちらで来たかは Content-Type と Accept で判定する。
 */
import type { APIRoute } from 'astro';
import { addCaseLog, createCase, type CaseRow } from '../../lib/cases';
import { formDataToRecord, parseAttribution, parseIntake } from '../../lib/intake';
import { ownerNoticeMail, receiptMailForApply, receiptMailForConsult, sendMail } from '../../lib/mail';
import { notifyOwner } from '../../lib/notify';
import { readVar } from '../../lib/config';
import { verifyTurnstile } from '../../lib/turnstile';

export const prerender = false;

/**
 * ボディ上限。申込は3項目、無料相談でも自由記入は「ご相談内容」2000字までなので、
 * 正常な送信は数KBに収まる。64KB は余裕を持たせた上限で、これを超えるのは事故か攻撃。
 */
const MAX_BODY_BYTES = 64 * 1024;

/** 同一IPからの受付回数の上限（RATE_WINDOW_MS の間に RATE_MAX 回まで）。 */
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60_000;

/**
 * IPごとの受付時刻。Worker のインスタンスに載るだけなので厳密ではない
 * （インスタンスが分かれれば別カウント。/api/ev と同じ割り切りで、本気の攻撃は
 *  Cloudflare の Rate Limiting Rules で前段に落とす前提の下限の防御）。
 */
const hits = new Map<string, number[]>();
const RATE_MAX_ENTRIES = 2000;

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);

  // Map が無限に伸びないよう、溜まってきたら窓を過ぎたIPを掃除する。
  if (hits.size >= RATE_MAX_ENTRIES) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
    if (hits.size >= RATE_MAX_ENTRIES) hits.clear();
  }
  hits.set(ip, recent);
  return false;
}

/** /api/ev と同じ取り方。Cloudflare 経由なら CF-Connecting-IP が付く。 */
function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0]!.trim();
  return 'local';
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

/** 素の <form> ポスト用。303 にするのは、リロードで同じ POST が飛ばないようにするため。 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/**
 * JS 無しで送ってきた人向けのエラー画面。
 * フォームの入力値はここには戻せない（サーバ側で画面を組み直していないため）ので、
 * 「戻るボタンで戻って直す」と明示する。ブラウザの戻るなら入力は残っている。
 */
function errorHtml(errors: string[], heading = '入力に不備があります'): Response {
  const items = errors.length ? errors : ['入力内容を確認してください'];
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${esc(heading)}</title>` +
      `<style>body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#fafaf8;color:#2d3748;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
      `div{max-width:520px;background:#fff;border:1px solid #d1e8f5;border-radius:8px;padding:32px;` +
      `box-shadow:0 2px 12px rgba(26,40,64,.06)}h1{font-size:18px;color:#1a2840;margin:0 0 12px}` +
      `ul{font-size:14px;line-height:1.9;margin:0 0 16px;padding-left:20px}p{font-size:14px;line-height:1.9;margin:0}` +
      `</style></head><body><div><h1>${esc(heading)}</h1>` +
      `<ul>${items.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` +
      `<p>ブラウザの戻るボタンで戻って修正してください。</p></div></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } },
  );
}

/** 生の回答から控えに残さない項目を落とす（トークンは使い捨て、ハニーポットは常に空）。 */
function submissionOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  delete out['cf-turnstile-response'];
  delete out.website;
  return out;
}

/** 受付確認メール（顧客宛）。送れても送れなくても case_log に結果を残す。 */
async function sendReceipt(c: CaseRow): Promise<void> {
  const mail = c.kind === 'consult' ? receiptMailForConsult(c) : receiptMailForApply(c);
  const r = await sendMail({ to: c.email, subject: mail.subject, text: mail.text });
  if (r.ok) {
    await addCaseLog(c.id, 'mail', `受付確認メールを送信: ${mail.subject}`);
  } else if (r.skipped) {
    await addCaseLog(c.id, 'note', 'メール送信が未設定のため受付確認メールは送っていない');
  } else {
    console.error(`[apply] 受付確認メールの送信に失敗 case=${c.id}: ${r.error ?? ''}`);
    await addCaseLog(c.id, 'note', `受付確認メールの送信に失敗: ${r.error ?? ''}`);
  }
}

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);

  // 先にヘッダだけで落とせるものを落とす（巨大なボディを読み込まないため）。
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    console.error(`[apply] ボディが大きすぎる ip=${ip} length=${declared}`);
    return json({ ok: false, error: 'too_large' }, 413);
  }

  if (rateLimited(ip, Date.now())) {
    console.error(`[apply] レート制限 ip=${ip}`);
    return json({ ok: false, error: 'rate_limit' }, 429);
  }

  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const accept = (request.headers.get('Accept') ?? '').toLowerCase();
  const isJsonRequest = contentType.includes('application/json');
  /** 応答を JSON で返すか。JSON で送ってきたか、JSON を受け取りたいと言っているか。 */
  const wantsJson = isJsonRequest || accept.includes('application/json');

  let raw: Record<string, unknown>;
  try {
    if (isJsonRequest) {
      const body = await request.text();
      // Content-Length が付かない送り方（chunked）への保険。文字数はバイト数より小さめに出るが、
      // ここは事故と攻撃を弾ければよいので厳密なバイト数は要らない。
      if (body.length > MAX_BODY_BYTES) {
        console.error(`[apply] JSON ボディが大きすぎる ip=${ip}`);
        return json({ ok: false, error: 'too_large' }, 413);
      }
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object ではない');
      raw = parsed as Record<string, unknown>;
    } else {
      raw = formDataToRecord(await request.formData());
    }
  } catch (e) {
    console.error(`[apply] ボディを読めなかった ip=${ip}`, e);
    return wantsJson ? json({ ok: false, error: 'bad_request' }, 400) : errorHtml(['送信内容を読み取れませんでした']);
  }

  const parsed = parseIntake(raw);

  // ハニーポットに引っかかった＝bot。**成功したふりをして何もしない。**
  // エラーを返すと bot 側に「弾かれた」と分かって作りを変えられるため。
  if (!parsed.ok && parsed.spam) {
    console.warn(`[apply] ハニーポットで遮断 ip=${ip}`);
    return wantsJson ? json({ ok: true, code: '', redirect: '/thanks' }) : seeOther('/thanks');
  }

  /*
    Turnstile は**申込フォーム（/apply）だけに掛ける。**

    無料相談の入口 `/contact` は public/ 配下の素の HTML で、サイトキーを埋め込めないので
    ウィジェットを置けない（＝トークンを送れない）。ここを一律で必須にすると、
    TURNSTILE_SECRET_KEY を設定した瞬間に `/contact` からの相談が全部弾かれる。

    相談側の防御はハニーポットと同一IPのレート制限に任せる。通るのは1行の作成だけで、
    スパムが増えたら /admin/cases で消せる。相談の量が増えて実害が出たら、
    `/contact` を Astro ページに移してウィジェットを載せる（そのとき この分岐を外す）。
  */
  /*
    **サイトキーが空のときはサーバ側でも検証しない。**
    ウィジェットは TURNSTILE_SITE_KEY があるときしか描画しない（apply.astro）ので、
    秘密鍵だけ先に入れると「画面にウィジェットが無いのにトークン必須」になり、
    申し込みが1件も通らなくなる。保存前に弾かれるので case_log にも痕跡が残らず、
    気づくのが遅れる。**片方だけ入れても壊れない**ようにここで揃っているかを見る。
  */
  const turnstileReady = readVar('TURNSTILE_SITE_KEY') !== '' && readVar('TURNSTILE_SECRET_KEY') !== '';
  const needsTurnstile = turnstileReady && raw.kind !== 'consult';
  if (needsTurnstile) {
    const token = typeof raw['cf-turnstile-response'] === 'string' ? raw['cf-turnstile-response'] : '';
    const turnstile = await verifyTurnstile(token, ip);
    if (!turnstile.ok) {
      console.error(`[apply] Turnstile の検証に失敗 ip=${ip}`);
      return wantsJson
        ? json({ ok: false, error: 'turnstile' }, 400)
        : errorHtml(
            ['自動送信でないことを確認できませんでした'],
            '送信を確認できませんでした',
          );
    }
  }

  if (!parsed.ok) {
    return wantsJson ? json({ ok: false, errors: parsed.errors }, 400) : errorHtml(Object.values(parsed.errors));
  }

  const { source, medium, campaign } = parseAttribution(raw);

  let c: CaseRow;
  try {
    c = await createCase(parsed.value, { submission: submissionOf(raw), source, medium, campaign });
  } catch (e) {
    // ここだけは失敗を隠さない。保存できていないのに完了画面を出すと申込が消える。
    console.error('[apply] 案件の保存に失敗', e);
    return wantsJson
      ? json({ ok: false, error: 'server' }, 500)
      : errorHtml(['受付処理でエラーが発生しました。時間をおいて再度お試しください'], '受付できませんでした');
  }

  // ここから先は「送れなくても受付は成立している」。失敗しても応答は成功で返す。
  try {
    await sendReceipt(c);
  } catch (e) {
    console.error(`[apply] 受付確認メールの処理で例外 case=${c.id}`, e);
  }

  try {
    const notice = ownerNoticeMail(c);
    await notifyOwner(notice.subject, notice.text);
  } catch (e) {
    console.error(`[apply] 運営者通知で例外 case=${c.id}`, e);
  }

  const redirect = `/thanks?c=${encodeURIComponent(c.code)}`;
  return wantsJson ? json({ ok: true, code: c.code, redirect }) : seeOther(redirect);
};
