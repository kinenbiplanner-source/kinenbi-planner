/**
 * 運用ダッシュボード（GET /dashboard）。
 *
 * 中身はリポジトリ直下の `ダッシュボード.html`。もともとローカルでファイルを直接開いて
 * 使っていたが、それだとマシンを変えると見られない・LPのリンクが相対パスで壊れる、の2点で
 * 実用に耐えなかったので、本番から配信する形にした。
 *
 * HTMLは `?raw` で取り込む（Vite の機能）。public/ に置いてアセット配信させないのは、
 * public/ 配下は誰でも取れてしまい、認証を挟む余地が無くなるため。
 * ここを通すことで「Astro のビルドに同梱されるが、URLは Worker が守る」形にできる。
 *
 * 認証について：
 * src/middleware.ts の isProtected が `/dashboard` を保護対象に含めているので、
 * ここに来た時点で locals.user は入っている。それでも下で見ているのは、
 * middleware 側の判定を後から誰かが変えたときに、事業の固定費や外部サービスの
 * 入口一覧が黙って全公開されるのを防ぐため（多重防御）。
 * Cloudflare Access 側のパスポリシーにも /dashboard を足す必要がある。
 */
import type { APIRoute } from 'astro';
import dashboardHtml from '../../ダッシュボード.html?raw';

export const prerender = false;

/**
 * ダッシュボードはインデックスされては困る。
 * HTML側にも robots メタを入れてあるが、ヘッダでも念のため宣言する
 * （メタは HTML を解釈しないクローラに効かない）。
 */
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

export const GET: APIRoute = ({ locals }) => {
  if (!locals.user) {
    return new Response(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
        `<meta name="robots" content="noindex,nofollow"><title>アクセスできません</title></head>` +
        `<body><h1>アクセスできません</h1>` +
        `<p>このページは認証が必要です。src/middleware.ts の保護対象に /dashboard が` +
        `含まれているか確認してください。</p></body></html>`,
      { status: 403, headers: HTML_HEADERS },
    );
  }

  return new Response(dashboardHtml, { headers: HTML_HEADERS });
};
