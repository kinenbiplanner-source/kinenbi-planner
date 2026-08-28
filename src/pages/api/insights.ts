/**
 * 自前計測の集計（GET /api/insights）。
 *
 * /dashboard の「計測」欄がこれを叩く。出どころは D1 の `event_daily`（/api/ev が書く）と
 * `pageviews`（/api/pv が書く）で、**GA4 とは別系統**。GA4 の数字は `/api/ga4` から取る。
 *
 * 認証は src/middleware.ts が `/api/*` 全体に掛けている。
 * **PUBLIC_API には入れないこと**（流入元別のCV数は事業の内部情報）。
 *
 * 集計はここで済ませる。画面側でループを回すと、期間を変えるたびに全行を舐めることになるし、
 * 「どう畳んだか」がHTMLに散ってしまう。**畳み方の定義はこのファイル1か所**にする。
 */
import type { APIRoute } from 'astro';
import { eventFirstYmd, eventsSince, jstYmd, pvDailyTotals, pvFirstYmd } from '../../lib/db';

export const prerender = false;

/** CV として扱うイベント。計測設計.md 6章のキーイベントと揃える。 */
const CONVERSIONS = new Set(['line_add_click', 'form_complete']);

function ymdDaysAgo(days: number): string {
  return jstYmd(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

export const GET: APIRoute = async ({ url }) => {
  const raw = Number(url.searchParams.get('days') ?? '28');
  const days = [7, 28, 90].includes(raw) ? raw : 28;
  const since = ymdDaysAgo(days);

  const [rows, pvDaily, evFirst, pvFirst] = await Promise.all([
    eventsSince(since),
    pvDailyTotals(since),
    eventFirstYmd(),
    pvFirstYmd(),
  ]);

  // 流入元 × メディア。イベント総数とCV数を並べて持つ
  // （「来ているのにCVしない流入元」を1行で見分けられるようにするため）。
  const bySource = new Map<string, { source: string; medium: string; events: number; conversions: number }>();
  // イベント名ごとの合計
  const byName = new Map<string, number>();
  // 発火場所ごとのCV（どのCTAが効いているか）
  const byLabel = new Map<string, number>();
  // CVの日次推移
  const cvDaily = new Map<string, number>();

  for (const r of rows) {
    const key = `${r.source}|${r.medium}`;
    const s = bySource.get(key) ?? { source: r.source, medium: r.medium, events: 0, conversions: 0 };
    s.events += r.count;

    byName.set(r.name, (byName.get(r.name) ?? 0) + r.count);

    if (CONVERSIONS.has(r.name)) {
      s.conversions += r.count;
      byLabel.set(`${r.name}:${r.label}`, (byLabel.get(`${r.name}:${r.label}`) ?? 0) + r.count);
      cvDaily.set(r.ymd, (cvDaily.get(r.ymd) ?? 0) + r.count);
    }
    bySource.set(key, s);
  }

  const conversions = [...byName.entries()]
    .filter(([n]) => CONVERSIONS.has(n))
    .reduce((n, [, v]) => n + v, 0);

  const body = {
    days,
    since,
    /** 計測が動き出した日。ここより前の期間を「ゼロ」と読ませないために出す */
    firstYmd: { events: evFirst, pageviews: pvFirst },
    totals: {
      events: rows.reduce((n, r) => n + r.count, 0),
      conversions,
      pageviews: pvDaily.reduce((n, d) => n + d.n, 0),
    },
    sources: [...bySource.values()].sort((a, b) => b.events - a.events),
    events: [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    ctas: [...byLabel.entries()]
      .map(([k, count]) => {
        const [name, label] = k.split(':');
        return { name: name ?? '', label: label ?? '', count };
      })
      .sort((a, b) => b.count - a.count),
    cvDaily: [...cvDaily.entries()].map(([ymd, n]) => ({ ymd, n })).sort((a, b) => (a.ymd < b.ymd ? -1 : 1)),
    pvDaily,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
};
