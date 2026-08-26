/**
 * ダッシュボード（/admin/stats）の集計ロジック。
 *
 * DBから引いた素の行（src/lib/db.ts の pvDailyTotals / pvSince）を、
 * 画面が必要とする形（日付の穴埋め・期間比較・SVGの座標）に変える純粋関数だけを置く。
 * .astro 側に計算を書かないのは、日付の境界や割り算の扱いを一箇所に集めておかないと
 * 「グラフと表で数字が合わない」が起きるため。
 *
 * 日付はすべて JST の YYYY-MM-DD 文字列で扱う（pageviews.ymd と同じ形）。
 * Date に戻すときは必ず UTC 正午を基準にする。ローカルタイムで解釈すると
 * 実行環境のTZ次第で1日ずれるため。
 */

/* ────────────────────────────────────────────────
 * しきい値
 *
 * 立ち上げ期の暫定値。記事が20本を超えて実データが溜まったら見直す。
 * 「なんとなく少ない」ではなく数字で線を引いておかないと、
 * リライトの判断が毎回その場の気分になるので定数として置いている。
 * ──────────────────────────────────────────────── */

/** 期間比較の窓。4週間ちょうどにして曜日の偏り（週末は検索が減る）を打ち消す。 */
export const WINDOW_DAYS = 28;

/** グラフで選べる期間。 */
export const CHART_RANGES = [30, 90] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

/** 公開からこの日数を過ぎても伸びない記事はリライト候補（インデックスと初期評価が付く目安）。 */
export const STALE_AFTER_DAYS = 45;
/** 上の日数を過ぎて、直近28日のPVがこれ未満なら「伸びていない」。 */
export const STALE_PV_UNDER = 20;
/** 直近28日が前28日のこの割合を下回ったら「下降」。 */
export const DROP_RATIO = 0.7;
/** ただし前28日がこの数に満たないものは、母数が小さすぎるので下降と見なさない。 */
export const DROP_MIN_PREV_PV = 30;

/* ────────────────────────────────────────────────
 * 日付
 * ──────────────────────────────────────────────── */

/** YYYY-MM-DD を UTC 正午の Date に。日付計算の基準はここに統一する。 */
function toDate(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

/** 日付をずらす（delta は日数。負なら過去）。 */
export function shiftYmd(ymd: string, delta: number): string {
  const d = toDate(ymd);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** end を含む直近 days 日分の日付を古い順に。 */
export function ymdRange(end: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftYmd(end, -i));
  return out;
}

/** from から to までの日数（to のほうが新しければ正）。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
}

/** ISO8601（UTC）を JST の YYYY-MM-DD に。published_at はこの形で入っている。 */
export function isoToYmd(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** MM/DD。グラフの軸ラベル用。 */
export function mmdd(ymd: string): string {
  return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
}

/* ────────────────────────────────────────────────
 * 系列の組み立て
 * ──────────────────────────────────────────────── */

/**
 * PVが0の日は pageviews に行が無い。グラフで日付が詰まって見えないよう0で埋める。
 * これをやらないと横軸の間隔が実際の日数とずれる。
 */
export function fillSeries(rows: Array<{ ymd: string; n: number }>, ymds: string[]): number[] {
  const by = new Map(rows.map((r) => [r.ymd, r.n]));
  return ymds.map((d) => by.get(d) ?? 0);
}

/** 記事ID → 日付 → PV。pvSince の戻りをそのまま渡す。 */
export function pivotByArticle(
  rows: Array<{ article_id: number; ymd: string; count: number }>,
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const r of rows) {
    let m = out.get(r.article_id);
    if (!m) out.set(r.article_id, (m = new Map()));
    m.set(r.ymd, (m.get(r.ymd) ?? 0) + r.count);
  }
  return out;
}

export function sumOver(by: Map<string, number> | undefined, ymds: string[]): number {
  if (!by) return 0;
  let n = 0;
  for (const d of ymds) n += by.get(d) ?? 0;
  return n;
}

export function seriesOver(by: Map<string, number> | undefined, ymds: string[]): number[] {
  return ymds.map((d) => by?.get(d) ?? 0);
}

/**
 * 前期比（%）。前期が0のときは倍率を出せないので null を返し、画面側では「—」にする
 * （0→5 を「+500%」と書くと伸び方を過大に見せる）。
 */
export function deltaPct(current: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((current - prev) / prev) * 100);
}

/** 移動平均。窓に満たない先頭は null（線を引かない）。 */
export function movingAverage(values: number[], window: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= window) sum -= values[i - window] ?? 0;
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/* ────────────────────────────────────────────────
 * リライト候補の判定
 * ──────────────────────────────────────────────── */

export type PerfFlag = { kind: 'stale' | 'drop'; label: string; hint: string };

/**
 * 記事1本の状態を見て、手を入れるべきものに印を付ける。
 * 「PVが少ない」だけで出すと公開直後の記事が全部引っかかるので、
 * 経過日数と前期比の両方を見る。
 */
export function perfFlag(input: { ageDays: number | null; pv: number; prevPv: number }): PerfFlag | null {
  const { ageDays, pv, prevPv } = input;
  if (prevPv >= DROP_MIN_PREV_PV && pv < prevPv * DROP_RATIO) {
    return {
      kind: 'drop',
      label: '下降',
      hint: `直近${WINDOW_DAYS}日が前${WINDOW_DAYS}日の${Math.round(DROP_RATIO * 100)}%を下回った`,
    };
  }
  if (ageDays !== null && ageDays >= STALE_AFTER_DAYS && pv < STALE_PV_UNDER) {
    return {
      kind: 'stale',
      label: '伸び悩み',
      hint: `公開から${STALE_AFTER_DAYS}日以上たって直近${WINDOW_DAYS}日が${STALE_PV_UNDER}PV未満`,
    };
  }
  return null;
}

/* ────────────────────────────────────────────────
 * SVG（サーバ側で描く）
 *
 * グラフライブラリは入れない。日次の棒と移動平均線しか要らないのに
 * 数十KBのJSを管理画面に持ち込む理由が無く、SSRなら描画待ちも無い。
 * ──────────────────────────────────────────────── */

/** 目盛りが半端な数にならないよう、1/2/5 × 10^n に切り上げる。 */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}

export interface BarChart {
  width: number;
  height: number;
  max: number;
  /** 描画領域。ホバー判定の透明な矩形を敷くのに使う。 */
  plot: { x: number; y: number; w: number; h: number };
  /**
   * 棒。hx/hw は「その日の担当範囲」で、0PVの日にもツールチップを出すための
   * 透明な当たり判定に使う（棒そのものは高さ0なのでホバーできない）。
   */
  bars: Array<{ x: number; y: number; w: number; h: number; hx: number; hw: number; ymd: string; n: number }>;
  /** 移動平均の polyline points。窓に満たなければ空文字。 */
  avg: string;
  ticks: Array<{ y: number; label: string }>;
  xLabels: Array<{ x: number; label: string }>;
  /** 系列が全部0か（画面側で「まだPVがありません」に切り替える） */
  empty: boolean;
}

const PAD = { top: 12, right: 8, bottom: 20, left: 38 };

/**
 * 日次PVの棒グラフ。viewBox は固定で、表示側は width:100% で伸ばす。
 * 棒は最低1pxの高さを持たせる（1PVの日が潰れて「0の日」と区別できなくなるため）。
 */
export function buildBarChart(
  ymds: string[],
  values: number[],
  opts: { width?: number; height?: number; avgWindow?: number } = {},
): BarChart {
  // viewBox は幅1200で描く。管理画面のカード内の実寸（1300px前後）に近い値にしておくと、
  // width:100% で伸ばしたときの拡大率が1倍付近に収まり、軸ラベルの文字だけが
  // 巨大になる（＝本文13pxのUIの中で浮く）のを避けられる。
  const width = opts.width ?? 1200;
  const height = opts.height ?? 260;
  const avgWindow = opts.avgWindow ?? 7;

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const peak = Math.max(0, ...values);
  const max = niceMax(peak);
  const slot = plotW / Math.max(1, values.length);
  const barW = Math.max(1.5, Math.min(18, slot * 0.68));
  const baseline = PAD.top + plotH;
  const y = (v: number) => baseline - (v / max) * plotH;

  const bars = values.map((n, i) => {
    const top = y(n);
    return {
      x: PAD.left + slot * i + (slot - barW) / 2,
      y: n > 0 ? Math.min(top, baseline - 1) : baseline,
      w: barW,
      h: n > 0 ? Math.max(1, baseline - top) : 0,
      hx: PAD.left + slot * i,
      hw: slot,
      ymd: ymds[i] ?? '',
      n,
    };
  });

  const avg = movingAverage(values, avgWindow)
    .map((v, i) => (v === null ? null : `${(PAD.left + slot * i + slot / 2).toFixed(1)},${y(v).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(' ');

  const ticks = [0, 0.5, 1].map((r) => ({
    y: baseline - r * plotH,
    label: String(Math.round(max * r)),
  }));

  // ラベルは6本前後に間引く。30日なら5日おき、90日なら15日おきになる。
  const every = Math.max(1, Math.ceil(values.length / 6));
  const xLabels: BarChart['xLabels'] = [];
  for (let i = values.length - 1; i >= 0; i -= every) {
    xLabels.unshift({ x: PAD.left + slot * i + slot / 2, label: mmdd(ymds[i] ?? '') });
  }

  return {
    width,
    height,
    max,
    plot: { x: PAD.left, y: PAD.top, w: plotW, h: plotH },
    bars,
    avg,
    ticks,
    xLabels,
    empty: peak === 0,
  };
}

export interface Spark {
  width: number;
  height: number;
  /** 折れ線 */
  line: string;
  /** 線の下の塗り */
  area: string;
  empty: boolean;
}

/**
 * 表の行に置く極小グラフ。縦は「その記事の中での相対」で正規化する
 * （記事間でPVの桁が違うので、共通軸にすると小さい記事が全部平らになる）。
 */
export function buildSpark(values: number[], width = 96, height = 24): Spark {
  const peak = Math.max(0, ...values);
  if (values.length < 2 || peak === 0) {
    return { width, height, line: '', area: '', empty: true };
  }
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    // 上下に1pxずつ余白を残して、天井と床で線が切れないようにする。
    const yy = height - 1 - (v / peak) * (height - 2);
    return `${(i * step).toFixed(1)},${yy.toFixed(1)}`;
  });
  return {
    width,
    height,
    line: pts.join(' '),
    area: `0,${height} ${pts.join(' ')} ${width},${height}`,
    empty: false,
  };
}
