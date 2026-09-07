/**
 * 案件へのメモ追加（POST /api/cases/[id]/note）。case_log に kind='note' で1行足す。
 * 案件に手書きのメモを1件足す。編集・削除は無い（履歴は積むだけ）。
 * 認証は src/middleware.ts。json / fail / readJson は ../[id].ts と同じもの（複製の理由はあちらの冒頭）。
 */
import type { APIRoute } from 'astro';
import { addCaseLog, getCase } from '../../../../lib/cases';

export const prerender = false;

const MAX_BODY = 4000;

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

  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body) return fail(400, 'メモが空です');
  if (body.length > MAX_BODY) return fail(400, `メモは ${MAX_BODY} 字までです`);

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  await addCaseLog(id, 'note', body);
  return json({ ok: true });
};
