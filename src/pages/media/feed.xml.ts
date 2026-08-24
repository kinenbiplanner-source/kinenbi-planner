/**
 * メディアのRSS 2.0フィード（/media/feed.xml）。
 *
 * @astrojs/rss は使わない。記事は D1 にあり、ビルド時には1本も存在しないため、
 * 静的生成前提のヘルパーに乗せる意味がない。
 */
import type { APIRoute } from 'astro';
import { listAllPublished } from '../../lib/db';

export const prerender = false;

const SITE = 'https://anniv.gift';
const FEED_LIMIT = 20;

/** XMLの特殊文字を潰す。記事タイトルに & や < が入っても壊れないようにするため。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RSSの日付は RFC 822。toUTCString() がそのまま使える形を返す。 */
function rfc822(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

export const GET: APIRoute = async () => {
  const all = await listAllPublished();
  const items = all.slice(0, FEED_LIMIT);

  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    '<channel>\n' +
    '<title>記念日のヒント | Anniv</title>\n' +
    `<link>${SITE}/media</link>\n` +
    '<description>プレゼント選びから当日の演出まで、記念日を成功させるための考え方をまとめています。</description>\n' +
    '<language>ja</language>\n' +
    `<lastBuildDate>${rfc822(items[0]?.updated_at ?? null)}</lastBuildDate>\n` +
    `<atom:link href="${SITE}/media/feed.xml" rel="self" type="application/rss+xml" />\n` +
    items
      .map(
        (a) =>
          '<item>\n' +
          `<title>${esc(a.title)}</title>\n` +
          `<link>${SITE}/media/${esc(a.slug)}</link>\n` +
          `<guid isPermaLink="true">${SITE}/media/${esc(a.slug)}</guid>\n` +
          `<pubDate>${rfc822(a.published_at)}</pubDate>\n` +
          `<description>${esc(a.description)}</description>\n` +
          '</item>\n',
      )
      .join('') +
    '</channel>\n</rss>\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400',
    },
  });
};
