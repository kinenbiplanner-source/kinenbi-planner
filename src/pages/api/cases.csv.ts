/**
 * 申し込みの回答をCSVで書き出す（GET /api/cases.csv）。
 *
 * `/admin/cases/insights` は「よく見る切り口」を先に固めて出す画面。
 * それ以外の切り方（予算×交際期間のクロスなど）をやりたくなったときのために、
 * 生の回答を表計算へ持ち出せるようにしておく。集計の正はあくまでD1で、これは派生物。
 *
 * `?days=30` で期間を絞れる（insights の期間フィルタと同じ値）。
 *
 * 認証は src/middleware.ts（Cloudflare Access の JWT 検証）。
 * 出力に氏名・メール・電話は含めない（回答の傾向を見るのが目的で、名寄せは管理画面でやる）。
 * ただし記念日・予算・自由記述と流入元が揃うと個人が絞れるので、公開APIには絶対にしない。
 */
import type { APIRoute } from 'astro';
import { listAnswers, parseInterests, type AnswerRow } from '../../lib/cases';
import { kindLabel, statusLabel, DELEGATION_OPTIONS } from '../../lib/intake';

export const prerender = false;

const HEADER = [
  'ID', '種別', '状態', '申込日時', '記念日の種類', '記念日',
  '交際期間', '予算', '申し込み種別', 'お任せ度', '過ごし方',
  '本人年齢', 'パートナー年齢', '興味', '希望・こだわり', '相談内容',
  '流入元', 'medium', 'campaign',
];

/**
 * CSVの1セル。
 * 先頭が = + - @ のセルは表計算がその場で数式として解釈するので、先頭に ' を足して無害化する
 * （回答は顧客が自由に書けるため。CSVインジェクション対策）。
 */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const JST = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function jst(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : JST.format(d).replace('T', ' ');
}

function toRow(r: AnswerRow): string {
  const delegation = DELEGATION_OPTIONS.find((d) => d.value === r.delegation)?.label ?? r.delegation;
  return [
    r.id,
    kindLabel(r.kind),
    statusLabel(r.status),
    jst(r.created_at),
    r.anniversary,
    r.anniversary_date,
    r.relationship,
    r.budget,
    r.express ? 'スピード対応' : '通常',
    delegation,
    r.past_style,
    r.age,
    r.partner_age,
    parseInterests(r).join(' / '),
    r.wishes,
    r.message,
    r.source,
    r.medium,
    r.campaign,
  ]
    .map(cell)
    .join(',');
}

export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get('days') ?? '';
  const days = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  const sinceIso = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;

  const rows = await listAnswers(sinceIso);
  // Excel が UTF-8 と判定できるように BOM を付ける（付けないと日本語が化ける）。
  const body = '﻿' + [HEADER.map(cell).join(','), ...rows.map(toRow)].join('\r\n') + '\r\n';

  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="anniv-cases-${stamp}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
