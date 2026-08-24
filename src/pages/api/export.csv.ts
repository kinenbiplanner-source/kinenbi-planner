/**
 * KWマスターDB.csv の書き出し（GET /api/export.csv）。
 *
 * D1 が記事の正になった後も、管理台帳（`記事管理/KWマスターDB.csv`）は
 * リライト計画や内部リンク設計を眺めるのに使う。手で二重管理すると必ずズレるので、
 * 「台帳は D1 から吐き出すもの」に寄せる。列は既存CSVのヘッダーと1文字も変えない。
 */
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { axisName } from '../../lib/axis';

export const prerender = false;

const HEADER = ['KW', '軸', 'ファネル層', 'タイトル', 'ステータス', 'URL', '公開日', 'リライト日', '備考'];

const SITE = 'https://anniv.gift';

interface Row {
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

/**
 * 日付は JST で切る。DB は ISO8601（UTC）で持っているので、
 * そのまま先頭10文字を取ると夜間に保存した記事が前日扱いになる。
 * 台帳を見るのは日本にいる運営者なので JST が正しい。
 */
const JST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function jstDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return JST_DATE.format(d);
}

/** RFC 4180。カンマ・改行・ダブルクォートを含む値だけ囲み、内側の " は "" にする。 */
function csvCell(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

export const GET: APIRoute = async () => {
  const { results } = await db()
    .prepare(
      `SELECT slug, title, keyword, axis, funnel, status, is_ad, published_at, updated_at
       FROM articles ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
    )
    .all<Row>();

  const lines = [csvRow(HEADER)];

  for (const r of results ?? []) {
    const published = jstDate(r.published_at);
    const updated = jstDate(r.updated_at);
    lines.push(
      csvRow([
        r.keyword,
        axisName(r.axis),
        r.funnel,
        r.title,
        r.status === 'published' ? '公開' : '下書き',
        r.status === 'published' ? `${SITE}/media/${r.slug}` : '',
        published,
        // 公開日と同じ日の更新は「公開しただけ」なのでリライトではない。
        // 別日に更新されていればリライト日として出す。
        updated && updated !== published ? updated : '',
        // 備考は台帳側の自由記入欄。D1 に対応する列が無いので、
        // 唯一機械的に分かる PR 表記（frontmatter の ad: true）だけ入れる。
        r.is_ad ? 'PR記事' : '',
      ]),
    );
  }

  // Excel は UTF-8 の CSV を BOM 無しだと Shift_JIS と誤認して化ける。
  // 改行も CRLF に揃えておく（Excel 以外でも問題にならない）。
  // BOM はエスケープで書く。ソースに生の U+FEFF を置くと編集時に消えても気付けない。
  const body = '\uFEFF' + lines.join('\r\n') + '\r\n';

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // 日本語ファイル名は filename*（RFC 5987）で渡す。素の filename に日本語を入れると
      // ヘッダ値が Latin-1 に収まらず Headers 構築時に落ちるので、こちらは ASCII の控えにする。
      'Content-Disposition':
        `attachment; filename="kw-master-db.csv"; ` +
        `filename*=UTF-8''${encodeURIComponent('KWマスターDB.csv')}`,
      'Cache-Control': 'private, no-store',
    },
  });
};
