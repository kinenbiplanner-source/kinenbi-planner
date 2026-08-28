/**
 * 計測ダッシュボード（GET /dashboard/measurement）。
 *
 * 中身はリポジトリ直下の `計測ダッシュボード.html`。もとは `ダッシュボード.html` の
 * 中に同居していたが、KPI・流入元・CTA別・日次と縦に伸びて画面の大半を占め、
 * 固定費とサービスの入口が埋もれていたので別ページに切り出した（2026-08-28）。
 * データの出どころ（/api/insights と /api/ga4）は変えていない。
 *
 * 配信の作りは `src/pages/dashboard.ts` と同じ：
 *   - HTMLは `?raw` で取り込む（public/ に置くと認証を挟む余地が無くなるため）
 *   - `locals.user` を自前でも見る（middleware の判定を誰かが変えても黙って公開されないように）
 *
 * middleware の isProtected は `/dashboard/` 配下をまとめて保護対象にしているので
 * 追加の変更は要らない。**Cloudflare Access 側のパスポリシーだけは要確認**
 * （`anniv.gift/dashboard` がサブパスまで含む設定になっていないと、Access のJWTが
 * 付かず locals.user が空になって、このページが403になる）。
 */
import type { APIRoute } from 'astro';
import measurementHtml from '../../../計測ダッシュボード.html?raw';

export const prerender = false;

/** ダッシュボードと同じくインデックスされては困る。HTML側のメタと二重で宣言する。 */
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
        `<p>このページは認証が必要です。Cloudflare Access のパスポリシーに` +
        ` /dashboard 配下が含まれているか確認してください。</p></body></html>`,
      { status: 403, headers: HTML_HEADERS },
    );
  }

  return new Response(measurementHtml, { headers: HTML_HEADERS });
};
