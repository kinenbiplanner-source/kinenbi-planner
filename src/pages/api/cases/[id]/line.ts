/**
 * 案件と LINE ユーザーの手動紐づけ（/api/cases/[id]/line）。
 *
 *   POST   { user_id } … line_users にいる userId を案件に付ける
 *   DELETE             … 外す
 *
 * 本線は Webhook（顧客が受付番号を送ると自動で付く。src/pages/api/line/webhook.ts）。
 * ここは「番号を送らずに普通に話しかけてきた」「別の番号を打ち間違えた」を管理画面から直す用。
 * 同じ userId が別案件に付いていたら linkLineUser がそちらを外して付け替える（1人1案件が原則）。
 * 認証は src/middleware.ts。json / fail / readJson は ../[id].ts と同じもの（複製の理由はあちらの冒頭）。
 */
import type { APIRoute } from 'astro';
import { getCase, linkLineUser, unlinkLineUser } from '../../../../lib/cases';
import { getLineUser } from '../../../../lib/line';

export const prerender = false;

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

  const userId = typeof raw.user_id === 'string' ? raw.user_id.trim() : '';
  if (!userId) return fail(400, 'user_id が空です');

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  // 友だち一覧に無い userId は付けない（Webhook を通っていない＝実在するか確かめようが無い）。
  const u = await getLineUser(userId);
  if (!u) return fail(404, 'その LINE ユーザーは友だち一覧にありません');

  await linkLineUser(id, userId, '管理画面で手動紐づけ');
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  await unlinkLineUser(id);
  return json({ ok: true });
};
