/**
 * KWマスターDB.csv の組み立て（純粋関数）。
 *
 * 台帳（`記事管理/KWマスターDB.csv`）は D1 から吐き出すもので、手では編集しない。
 * 吐き出す口が2つある：
 *   - GET /api/export.csv …… 管理画面の「CSVエクスポート」ボタン
 *   - scripts/update-pv.ts …… /anniv-update-pv（週1で、PVごと台帳を最新化する）
 *
 * 列の定義と行の整形をここに集めておかないと、2つの口で列がずれて
 * 「どっちで出したCSVか」で台帳の形が変わる。**列を足すときはここだけ触る。**
 *
 * `cloudflare:workers` に依存しない（ローカルの node から import するため。db.ts は読まない）。
 * 相対 import に `.ts` を付けているのも同じ理由（node の型剥がしは拡張子の推測をしない）。
 */
import { WINDOW_DAYS, daysBetween, deltaPct, isoToYmd, perfFlag, sumOver } from './stats.ts';
import { axisName } from './axis.ts';

export const SITE = 'https://anniv.gift';

/**
 * 先頭9列は従来どおり1文字も変えない（anniv-write-article Step 0-B は左の列だけを見る）。
 * PV列はその右に足す。値は全部 D1 から機械的に出るものだけ——人が書いた列は
 * エクスポートで上書きした瞬間に消えるので、この台帳には置かない
 * （リライトの判断とその理由は `記事管理/PVレポート/` の週次レポートに書く）。
 */
export const KW_CSV_HEADER: readonly string[] = [
  'KW',
  '軸',
  'ファネル層',
  'タイトル',
  'ステータス',
  'URL',
  '公開日',
  'リライト日',
  '備考',
  '累計PV',
  `直近${WINDOW_DAYS}日PV`,
  `前${WINDOW_DAYS}日PV`,
  '増減',
  '判定（自動）',
];

/** 台帳に要る記事の列。D1 の articles から SELECT する列と一致させる。 */
export interface KwCsvArticle {
  slug: string;
  title: string;
  keyword: string;
  axis: string;
  funnel: string;
  status: string;
  is_ad: number;
  published_at: string | null;
  updated_at: string;
}

/** 記事1本のPV成績。/admin/stats の記事別テーブルと同じ定義（src/lib/stats.ts）。 */
export interface KwCsvPerf {
  /** 累計（pageviews の全期間合計） */
  total: number;
  /** 直近 WINDOW_DAYS 日 */
  pv: number;
  /** その前の WINDOW_DAYS 日 */
  prevPv: number;
  /** 前期比（%）。前期0なら null */
  delta: number | null;
  /** perfFlag のラベル（下降／伸び悩み）。判定できない期間は空 */
  flag: string;
}

/**
 * 記事1本の成績を出す。/admin/stats（stats.astro）の計算と同じ手順で、
 * 「台帳と管理画面で数字が違う」を起こさないためにここへ寄せた。
 *
 * canJudge は「計測開始から WINDOW_DAYS 日たったか」。満たないうちは
 * 古い記事が全部「伸び悩み」に見えるので判定を出さない（stats.astro と同じ）。
 */
export function windowPerf(input: {
  publishedAt: string | null;
  today: string;
  by: Map<string, number> | undefined;
  curYmds: string[];
  prevYmds: string[];
  total: number;
  canJudge: boolean;
}): KwCsvPerf {
  const pv = sumOver(input.by, input.curYmds);
  const prevPv = sumOver(input.by, input.prevYmds);
  const pubYmd = isoToYmd(input.publishedAt);
  const ageDays = pubYmd ? daysBetween(pubYmd, input.today) : null;
  const flag = input.canJudge ? perfFlag({ ageDays, pv, prevPv }) : null;
  return {
    total: input.total,
    pv,
    prevPv,
    delta: deltaPct(pv, prevPv),
    flag: flag?.label ?? '',
  };
}

/**
 * 日付は JST で切る。DB は ISO8601（UTC）で持っているので、
 * そのまま先頭10文字を取ると夜間に保存した記事が前日扱いになる。
 * 台帳を見るのは日本にいる運営者なので JST が正しい。
 */
export function jstDate(iso: string | null): string {
  return isoToYmd(iso) ?? '';
}

/** RFC 4180。カンマ・改行・ダブルクォートを含む値だけ囲み、内側の " は "" にする。 */
export function csvCell(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

/** 前期比の表示。null は「—」ではなく空にする（表計算で数値列として扱えるように）。 */
function deltaText(d: number | null): string {
  if (d === null) return '';
  return `${d > 0 ? '+' : ''}${d}%`;
}

/**
 * 台帳1行。perf が null の行（下書き）はPV列を空で出す。
 * 下書きに 0 を入れると「公開したのに読まれていない」と見分けがつかない。
 */
export function kwCsvRow(article: KwCsvArticle, perf: KwCsvPerf | null): string[] {
  const published = jstDate(article.published_at);
  const updated = jstDate(article.updated_at);
  const isPublished = article.status === 'published';
  return [
    article.keyword,
    axisName(article.axis),
    article.funnel,
    article.title,
    isPublished ? '公開' : '下書き',
    isPublished ? `${SITE}/media/${article.slug}` : '',
    published,
    // 公開日と同じ日の更新は「公開しただけ」なのでリライトではない。
    // 別日に更新されていればリライト日として出す。
    updated && updated !== published ? updated : '',
    // 備考は台帳側の自由記入欄。D1 に対応する列が無いので、
    // 唯一機械的に分かる PR 表記（frontmatter の ad: true）だけ入れる。
    article.is_ad ? 'PR記事' : '',
    perf ? String(perf.total) : '',
    perf ? String(perf.pv) : '',
    perf ? String(perf.prevPv) : '',
    perf ? deltaText(perf.delta) : '',
    perf ? perf.flag : '',
  ];
}

/**
 * CSV 全文。
 * Excel は UTF-8 の CSV を BOM 無しだと Shift_JIS と誤認して化けるので BOM を付け、
 * 改行も CRLF に揃える（Excel 以外でも問題にならない）。
 * BOM はエスケープで書く。ソースに生の U+FEFF を置くと編集時に消えても気付けない。
 */
export function buildKwCsv(rows: Array<{ article: KwCsvArticle; perf: KwCsvPerf | null }>): string {
  const lines = [csvRow(KW_CSV_HEADER)];
  for (const r of rows) lines.push(csvRow(kwCsvRow(r.article, r.perf)));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
