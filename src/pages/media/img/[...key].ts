/**
 * R2 に置いた記事画像の配信（GET /media/img/<key>）。
 *
 * 公開ページの <img> から参照されるので、ここは認証を掛けない。
 * src/middleware.ts が守るのは /admin と /api の2つだけで、このパスはどちらでもない
 * （＝素通し）。管理画面のアップロード先と配信元を分けているのはそのため。
 *
 * キーは日付＋ランダム文字列付き（api/upload.ts）で推測できないが、
 * URL を知っていれば誰でも取れる。記事に載せる画像しか置かない前提。
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key ?? '';
  // アップロード側でキーは英数・ハイフン・ドットに正規化しているが、
  // 配信側でも遡上や空キーを弾いておく（R2 は相対パスを解釈しないので保険）。
  if (!key || key.includes('..')) {
    return new Response('Not Found', { status: 404 });
  }

  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  // put 時の httpMetadata（contentType）をそのまま復元する。
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  headers.set('ETag', object.httpEtag);
  // キーにランダム文字列が入っていて上書きされない＝内容は不変。
  // 1年 immutable で CDN にもブラウザにも貼り付ける。
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // 再訪時に転送量を使わないよう If-None-Match だけ見る。
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
};
