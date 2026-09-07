/**
 * 案件の顧客へ送る（POST /api/cases/[id]/send）。管理画面の返信フォームが叩く。
 *
 *   { channel: 'line', text }           … 紐づいた LINE userId へ push
 *   { channel: 'mail', subject, text }  … 案件のメールアドレスへ Resend で送信
 *
 * 送れたら line_messages（LINE のみ）と case_log に控えを残す。送れなかったら控えは残さない
 * （「送った」が履歴にあるのに届いていない、が一番困るため）。
 *
 * 顧客対応の本線は LINE Official Account Manager のチャットなので、ここは
 * 「案件を開いた流れでそのまま定型文を送る」用途に絞っている（src/lib/templates.ts）。
 * 認証は src/middleware.ts。json / fail / readJson は ../[id].ts と同じもの（複製の理由はあちらの冒頭）。
 */
import type { APIRoute } from 'astro';
import { addCaseLog, getCase } from '../../../../lib/cases';
import { ownerEmail } from '../../../../lib/config';
import { recordLineMessage } from '../../../../lib/line';
import { lineApiConfigured, pushText } from '../../../../lib/line-api';
import { mailConfigured, sendMail } from '../../../../lib/mail';

export const prerender = false;

/** LINE のテキスト上限（Messaging API の仕様）。メールはそこまで長くならない前提で同じ値にしている。 */
const MAX_TEXT = 5000;
const MAX_SUBJECT = 200;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const data = (await request.json()) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const POST: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const raw = await readJson(request);
  if (!raw) return fail(400, 'リクエストの形式が不正です');

  const channel = raw.channel;
  if (channel !== 'line' && channel !== 'mail') return fail(400, 'channel は line か mail を指定してください');

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return fail(400, '本文が空です');
  if (text.length > MAX_TEXT) return fail(400, `本文は ${MAX_TEXT} 字までです`);

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  if (channel === 'line') {
    if (!c.line_user_id) return fail(400, 'LINE が紐づいていません');
    if (!lineApiConfigured()) return fail(503, 'LINE 送信が未設定です（LINE_CHANNEL_ACCESS_TOKEN）');

    const r = await pushText(c.line_user_id, text);
    if (!r.ok) {
      console.error(`[send] LINE push 失敗 case=${id}: ${r.error ?? ''}`);
      return fail(502, r.error ?? 'LINE の送信に失敗しました');
    }
    const now = new Date().toISOString();
    await recordLineMessage(c.line_user_id, 'out', text, now);
    await addCaseLog(id, 'line_out', text);
    return json({ ok: true });
  }

  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!subject) return fail(400, '件名が空です');
  if (subject.length > MAX_SUBJECT) return fail(400, `件名は ${MAX_SUBJECT} 字までです`);
  if (!c.email) return fail(400, '案件にメールアドレスがありません');
  if (!mailConfigured()) return fail(503, 'メール送信が未設定です（RESEND_API_KEY）');

  // 送信元は noreply なので、顧客が返信したら運営者に届くよう Reply-To を付ける。
  const r = await sendMail({ to: c.email, subject, text, replyTo: ownerEmail() });
  if (!r.ok) {
    console.error(`[send] メール送信失敗 case=${id}: ${r.error ?? ''}`);
    return fail(502, r.error ?? 'メールの送信に失敗しました');
  }
  await addCaseLog(id, 'mail', `送信: ${subject}\n${text}`);
  return json({ ok: true });
};
