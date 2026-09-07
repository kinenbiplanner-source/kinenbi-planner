/**
 * 案件1件の取得・更新・削除（/api/cases/[id]）。管理画面 /admin/cases/[id] が叩く。
 *
 *   GET    … 案件本体＋履歴＋紐づいた LINE ユーザーとそのメッセージ控え
 *   PATCH  … 進行列の更新（書き換えてよい列は src/lib/cases.ts の PATCHABLE_FIELDS に閉じる）
 *   DELETE … 案件と履歴を消す（テスト投入の掃除用。本番の案件は status を lost にして残す）
 *
 * 認証は src/middleware.ts（Cloudflare Access の JWT 検証）が担当する。
 * /admin にしか Access のパスポリシーが掛かっていない以上、この API には素のリクエストが
 * 飛んでくる前提で書く＝入力は全部ここで検証する。
 *
 * 配下の note / send / line も同じ json / fail / readJson を持っている（各ファイルで小さく複製）。
 * `[id].ts` から import させると角括弧付きのパスを import 指定子に書くことになり、
 * ビルドを回さずに確かめられなかったので、確実な方を取った。
 */
import type { APIRoute } from 'astro';
import { getCase, listCaseLog, sanitizePatch, updateCase, type CaseLogRow, type CaseRow } from '../../../lib/cases';
import { db } from '../../../lib/db';
import { getLineUser, listLineMessages, type LineMessageRow, type LineUserRow } from '../../../lib/line';

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

/** GET の応答。紐づけが無ければ line_user は null、messages は空配列。 */
interface CaseDetail {
  case: CaseRow;
  log: CaseLogRow[];
  line_user: LineUserRow | null;
  messages: LineMessageRow[];
}

export const GET: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  const log = await listCaseLog(id);
  let line_user: LineUserRow | null = null;
  let messages: LineMessageRow[] = [];
  if (c.line_user_id) {
    line_user = await getLineUser(c.line_user_id);
    messages = await listLineMessages(c.line_user_id);
  }
  const detail: CaseDetail = { case: c, log, line_user, messages };
  return json(detail);
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const raw = await readJson(request);
  if (!raw) return fail(400, 'リクエストの形式が不正です');

  const { patch, errors } = sanitizePatch(raw);
  if (errors.length) return json({ error: '入力に不備があります', errors }, 400);

  const updated = await updateCase(id, patch);
  if (!updated) return fail(404, '案件が見つかりません');
  return json({ ok: true, case: updated });
};

/**
 * 削除は cases と case_log の2テーブル。D1 にトランザクションは無いが batch は同一接続で
 * まとめて流れるので、履歴だけ残る中途半端な状態になりにくい。
 * line_users / line_messages は消さない（LINE の友だち関係は案件とは別に続いている）。
 */
export const DELETE: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const c = await getCase(id);
  if (!c) return fail(404, '案件が見つかりません');

  await db().batch([
    db().prepare('DELETE FROM case_log WHERE case_id=?').bind(id),
    db().prepare('DELETE FROM cases WHERE id=?').bind(id),
  ]);
  return json({ ok: true });
};
