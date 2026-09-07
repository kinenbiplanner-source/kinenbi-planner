/**
 * KWマスターDB.csv の書き出し（GET /api/export.csv）。
 *
 * D1 が記事の正になった後も、管理台帳（`記事管理/KWマスターDB.csv`）は
 * リライト計画や内部リンク設計を眺めるのに使う。手で二重管理すると必ずズレるので、
 * 「台帳は D1 から吐き出すもの」に寄せる。
 *
 * 列の定義と整形は src/lib/kw-csv.ts に置いてある。scripts/update-pv.ts（/anniv-update-pv）も
 * 同じモジュールで同じ列を書くので、どちらで出しても台帳の形は変わらない。
 * PV列（累計／直近28日／前28日／増減／判定）の計算も /admin/stats と同じ手順。
 */
import type { APIRoute } from 'astro';
import { db, jstYmd, pvFirstYmd, pvSince, pvTotals } from '../../lib/db';
import { WINDOW_DAYS, daysBetween, pivotByArticle, shiftYmd, ymdRange } from '../../lib/stats';
import { buildKwCsv, windowPerf, type KwCsvArticle } from '../../lib/kw-csv';

export const prerender = false;

interface Row extends KwCsvArticle {
  id: number;
}

export const GET: APIRoute = async () => {
  const today = jstYmd();
  const curYmds = ymdRange(today, WINDOW_DAYS);
  const prevYmds = ymdRange(shiftYmd(today, -WINDOW_DAYS), WINDOW_DAYS);

  // どれも独立したクエリなので同時に投げる。
  const [{ results }, windowRows, totals, firstYmd] = await Promise.all([
    db()
      .prepare(
        `SELECT id, slug, title, keyword, axis, funnel, status, is_ad, published_at, updated_at
         FROM articles ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
      )
      .all<Row>(),
    pvSince(prevYmds[0]!),
    pvTotals(),
    pvFirstYmd(),
  ]);

  // 計測開始から28日たつまでは判定を出さない（/admin/stats と同じ）。
  const measuredDays = firstYmd ? daysBetween(firstYmd, today) + 1 : 0;
  const canJudge = measuredDays >= WINDOW_DAYS;
  const perArticle = pivotByArticle(windowRows);

  const rows = (results ?? []).map((r) => ({
    article: r,
    perf:
      r.status === 'published'
        ? windowPerf({
            publishedAt: r.published_at,
            today,
            by: perArticle.get(r.id),
            curYmds,
            prevYmds,
            total: totals.get(r.id) ?? 0,
            canJudge,
          })
        : null,
  }));

  return new Response(buildKwCsv(rows), {
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
