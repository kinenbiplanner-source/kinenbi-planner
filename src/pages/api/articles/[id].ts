/**
 * 記事の更新（PUT）と削除（DELETE）。
 *
 * 検証・整形は新規作成側（../articles.ts）の buildArticleInput をそのまま使う。
 * 「新規では通るが更新では通らない」ような差異を作らないため、
 * 分岐は exceptId（slug 重複チェックから自分を除く）と
 * currentPublishedAt（公開日を引き継ぐ）の2点だけに閉じ込めている。
 */
import type { APIRoute } from 'astro';
import { deleteArticle, getById, syncKeywordForArticle, updateArticle } from '../../../lib/db';
import { buildArticleInput, fail, json, readJson } from '../articles';

export const prerender = false;

function parseId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const PUT: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const current = await getById(id);
  if (!current) return fail(404, '記事が見つかりません');

  const raw = await readJson(request);
  if (!raw) return fail(400, 'リクエストの形式が不正です');

  const built = await buildArticleInput(raw, {
    exceptId: id,
    currentPublishedAt: current.published_at,
  });
  if (!built.ok) return fail(built.status, built.message);

  await updateArticle(id, built.input);
  // 記事の保存に台帳を追従させる（手で「記事化済み」に倒す運用は必ず抜けるため）。
  const keyword = await syncKeywordForArticle(built.input.keyword, id, built.input.status);
  return json({ id, warnings: built.warnings, keyword });
};

export const DELETE: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'IDが不正です');

  const current = await getById(id);
  if (!current) return fail(404, '記事が見つかりません');

  await deleteArticle(id);
  // hero_image の R2 オブジェクトは消していない。別記事が同じキーを参照している
  // 可能性と、誤削除からの復旧余地を残すことを優先した（容量は問題にならない規模）。
  return json({ id, deleted: true });
};
