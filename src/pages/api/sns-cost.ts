/**
 * multi-SNS-manager の今月のコスト（GET /api/sns-cost）。
 *
 * /dashboard のコスト欄がこれを叩いて「今月いくら使ったか」を埋める。
 * ダッシュボードのHTMLを静的なまま保ちたいので、サーバ側で値を差し込むのではなく
 * クライアントから同一オリジンで取りに来る形にしてある
 * （こうしておくと、金額が変わってもデプロイし直さずに最新が出る）。
 *
 * 認証は src/middleware.ts が `/api/*` 全体に掛けている。
 * **ここは事業の支出額を返すので、PUBLIC_API には絶対に入れないこと。**
 */
import type { APIRoute } from 'astro';
import { fetchSnsCost } from '../../lib/sns-cost';

export const prerender = false;

export const GET: APIRoute = async () => {
  const summary = await fetchSnsCost();

  return new Response(JSON.stringify(summary), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 支出額なので中間では持たせない。ブラウザにも残さない。
      'Cache-Control': 'private, no-store',
    },
  });
};
