/**
 * sitemap.xml。
 *
 * @astrojs/sitemap は使わない（astro.config.mjs のコメント参照）。記事は D1 にあり、
 * ビルド時点では1本も存在しないため、静的生成では常に空のサイトマップになる。
 *
 * 載せるのは「検索結果に出したいURL」だけ。contact.html / thanks.html / links.html は
 * noindex 運用（メディア方針/計測設計.md 2章）なので入れない。
 */
import type { APIRoute } from 'astro';
import { listAllPublished, db } from '../lib/db';
import { AXES } from '../lib/axis';

export const prerender = false;

const SITE = 'https://anniv.gift';

/**
 * 公開記事が1本以上ある軸だけを返す。
 * 記事0本のカテゴリページは中身が「準備中」だけになるので、載せると
 * 薄いページを自分から申告することになる（そちら側でも noindex にしてある）。
 */
async function axesWithArticles(): Promise<Set<string>> {
  const { results } = await db()
    .prepare("SELECT axis FROM articles WHERE status='published' GROUP BY axis")
    .all<{ axis: string }>();
  return new Set((results ?? []).map((r) => r.axis));
}

/** LP側の静的ページ。public/ 配下に素のHTMLで置いてあるもの。 */
const STATIC_PATHS = ['/', '/privacy', '/tokutei'];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry(path: string, lastmod?: string | null): string {
  const mod = lastmod ? `\n<lastmod>${esc(lastmod)}</lastmod>` : '';
  return `<url>\n<loc>${SITE}${esc(path)}</loc>${mod}\n</url>\n`;
}

export const GET: APIRoute = async () => {
  const [articles, liveAxes] = await Promise.all([listAllPublished(), axesWithArticles()]);
  // 一覧の更新日は最新記事の更新日。listAllPublished は公開日の新しい順。
  const newest = articles[0]?.updated_at ?? null;

  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    STATIC_PATHS.map((p) => urlEntry(p)).join('') +
    urlEntry('/media', newest) +
    AXES.filter((a) => liveAxes.has(a.slug))
      .map((a) => urlEntry(`/media/category/${a.slug}`))
      .join('') +
    articles.map((a) => urlEntry(`/media/${a.slug}`, a.updated_at)).join('') +
    '</urlset>\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400',
    },
  });
};
