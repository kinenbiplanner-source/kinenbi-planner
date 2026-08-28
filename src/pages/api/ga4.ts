/**
 * GA4 の集計（GET /api/ga4）。
 *
 * /dashboard の「GA4」欄がこれを叩く。自前計測（/api/insights）とは**別の数字**で、
 * 突き合わせない（理由は src/lib/ga4.ts の冒頭）。
 *
 * 未設定でも 200 を返し、`available: false` と理由を載せる。
 * ダッシュボードは「—」と「未設定」を出し分けたいので、エラーにしない。
 *
 * 認証は src/middleware.ts が `/api/*` 全体に掛けている。PUBLIC_API には入れない。
 */
import type { APIRoute } from 'astro';
import { ga4Summary } from '../../lib/ga4';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const raw = Number(url.searchParams.get('days') ?? '28');
  const days = [7, 28, 90].includes(raw) ? raw : 28;

  const summary = await ga4Summary(days);

  return new Response(JSON.stringify(summary), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
};
