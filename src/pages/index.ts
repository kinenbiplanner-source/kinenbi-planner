import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * LPトップ（`/`）。
 *
 * 静的アセットは wrangler.jsonc で `html_handling: "none"` にしてある。
 * 既定の "auto-trailing-slash" だと `/contact.html` が `/contact` へ 307 で飛ばされ、
 * content-axis.md の軸3固定CTA・LPフッター・sitemap・Search Console に登録済みの
 * `.html` 付きURLが軒並みリダイレクト扱いになってしまうため。
 *
 * その副作用で `/` が `index.html` に自動解決されなくなるので、ここで補う。
 * **リダイレクトはしない**（`/` → `/index.html` にするとLPトップのURL自体が変わり、
 * index.html が宣言している canonical `https://anniv.gift/` と食い違う）。
 * ASSETS バインディングから中身を取り出してそのまま返す＝内部リライト。
 */
export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  url.pathname = '/index.html';
  const res = await env.ASSETS.fetch(new Request(url, { headers: request.headers }));
  // headers をコピーしてから返す（元の Response の headers は immutable なため）
  return new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
};
