/**
 * 週次のPV更新（/anniv-update-pv の本体）。
 *
 *   node --experimental-strip-types scripts/update-pv.ts
 *   node --experimental-strip-types scripts/update-pv.ts --dry-run   # 取得して表示するだけ。ファイルは書かない
 *   node --experimental-strip-types scripts/update-pv.ts --publish "記事管理/PVレポート/週次レポート_2026-09-06.md"
 *
 * 通常実行で何をするか：
 *   1. D1（本番）から記事・自前PV（pageviews）・導線イベント（event_daily）を引く
 *   2. GA4 Data API から /media/ 配下のページ別PVと流入チャネルを引く（任意・非致命）
 *   3. Search Console API から /media/ 配下のページ別・クエリ別の検索成績を引く（任意・非致命）
 *   4. 書き出す：
 *        記事管理/KWマスターDB.csv                 … /api/export.csv と同じ列（src/lib/kw-csv.ts）
 *        記事管理/PV履歴.csv                       … 日付スナップショット。同日に何度回しても上書き（二重計上しない）
 *        記事管理/PVレポート/現状ファクトシート.md … 毎回まっさらに再生成。Claudeが週次レポートを書くときの唯一の入力
 *        記事管理/PVレポート/gsc-queries.json      … GSC のクエリ×記事の断面（記事別の上位5件＋全体の上位100件に間引いたもの）。
 *                                                    --publish がこれを読んで pv_reports の snapshot に入れる。GSC が取れた回だけ書く
 *        記事管理/KW候補/gsc-queries.json          … 同じ GSC データをクエリ単位に束ねた全量（上限2000）。scripts/seo/volume.ts --gsc が
 *                                                    需要の代理指標として読む。GSC が取れた回だけ書く
 *      gsc-queries.json を2か所に書くのは用途が違うため：PVレポート側は画面に載せる断面なので小さく間引き、
 *      KW候補側は「台帳に無い語」を拾うためのもので、間引くと肝心の裾野が消える。
 *
 * --publish で何をするか：
 *   Claude が書いた週次レポート（Markdown）と、その日の記事別 GA4 / GSC の断面（PV履歴.csv から）、
 *   GSC のクエリ断面（PVレポート/gsc-queries.json から。無ければ空）を D1 の pv_reports に入れる。
 *   /admin/stats（メディア分析）がそれを読んで、レポート本文と GA4・GSC の列・検索クエリを出す。
 *   **ダッシュボードは D1 を読むだけなので、毎週の更新にデプロイは要らない。**
 *
 * ファクトシートの「GSC クエリ」節には、取りこぼし・striking distance に加えて
 * カニバリ（実測）・未カバーのクエリ（新KW候補）・リライト優先度を出す（2026-09-10）。
 * 3節を組む部分は export した純粋関数（buildGscExtraSections）で、node -e から固定データで確かめられる。
 *
 * 経路は put-draft.ts と同じで、D1 は wrangler（ユーザーの Cloudflare ログイン）で直接読み書きする。
 * /api/export.csv を curl で叩くには Access のサービストークンが要り、管理画面用に閉じてある口を
 * 機械のために開けることになるので、そうしない。
 *
 * GA4 / GSC の認証はサービスアカウント（Worker と同じ鍵）。値は `.dev.vars` から読む
 * （wrangler secret に入れたのと同じ3変数＋任意で GSC_SITE_URL。手順は メディア方針/計測設計.md 11章）。
 * 無ければその段だけ飛ばして自前PVだけで続行する——どれか1系統が落ちても台帳とファクトシートは出る。
 *
 * 3つの数字は必ずズレる（自前PV＝ビーコン、GA4＝gtag、GSC＝検索結果側）。突き合わせない。
 * 読み分けは：自前PV＝記事どうしの相対比較、GA4＝流入元と滞在、GSC＝検索での立ち位置。
 *
 * オプション：
 *   --dry-run          ファイルを書かない（取得と表示だけ）
 *   --local            ローカルの D1（astro dev 用）を読み書きする。既定は本番
 *   --no-ga4           GA4 を叩かない
 *   --no-gsc           Search Console を叩かない
 *   --publish <md>     週次レポートを D1 に入れる（上記）。日付はファイル名の YYYY-MM-DD から取る
 *   --date YYYY-MM-DD  --publish の日付を明示する（ファイル名に日付が無いとき）
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WINDOW_DAYS,
  STALE_AFTER_DAYS,
  daysBetween,
  deltaPct,
  isoToYmd,
  pivotByArticle,
  shiftYmd,
  ymdRange,
  type PvSnapshot,
  type PvSnapshotQuery,
  type PvSnapshotRow,
} from '../src/lib/stats.ts';
import { AXES, axisShort } from '../src/lib/axis.ts';
import { buildKwCsv, csvRow, windowPerf, type KwCsvArticle, type KwCsvPerf } from '../src/lib/kw-csv.ts';
import { gscCannibal } from '../src/lib/seo/cannibal.ts';
import { overlap, textCoverage, tokenize } from '../src/lib/seo/tokens.ts';

/* ────────────────────────────────────────────────
 * 場所と設定
 * ──────────────────────────────────────────────── */

/** リポジトリルート。どこから叩いても同じ場所に書く。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const DB_NAME = 'anniv';

const CSV_PATH = join(ROOT, '記事管理', 'KWマスターDB.csv');
const HISTORY_PATH = join(ROOT, '記事管理', 'PV履歴.csv');
const REPORT_DIR = join(ROOT, '記事管理', 'PVレポート');
const FACTSHEET_PATH = join(REPORT_DIR, '現状ファクトシート.md');
/** GSC のクエリ断面（間引き済み）。--publish が snapshot に入れる。 */
const GSC_QUERIES_SNAPSHOT_PATH = join(REPORT_DIR, 'gsc-queries.json');
/** GSC のクエリ全量（クエリ単位）。scripts/seo/volume.ts --gsc が読む。 */
const KW_CANDIDATE_DIR = join(ROOT, '記事管理', 'KW候補');
const GSC_QUERIES_ALL_PATH = join(KW_CANDIDATE_DIR, 'gsc-queries.json');
const DEV_VARS = join(ROOT, '.dev.vars');

/** GSC は直近2〜3日が未確定なので、集計の終端を3日手前に置く。 */
const GSC_LAG_DAYS = 3;
/** Search Console のプロパティ。メタタグ確認なので URL プレフィックス型が既定。ドメイン型なら `sc-domain:anniv.gift`。 */
const GSC_SITE_DEFAULT = 'https://anniv.gift/';

/*
 * GSC の抽出しきい値。立ち上げ期の暫定値で、爆速開発部側（表示≥50・順位5〜15・表示≥20）より
 * かなり低く置いている。表示が2桁しか無い時期に高い閾値を使うと何も出ず、
 * 「取りこぼしなし」と読み違えるため。記事が20本を超えて表示が3桁になったら上げる。
 */
/** 「表示はあるのに押されていない」：表示がこれ以上でCTRがこれ未満 */
const GSC_MISS_MIN_IMPR = 20;
const GSC_MISS_MAX_CTR = 0.02;
/** striking distance（あと一押しで1ページ目上位）：順位がこの範囲で表示がこれ以上 */
const STRIKE_POS_MIN = 4;
const STRIKE_POS_MAX = 20;
const STRIKE_MIN_IMPR = 5;
/** 記事別に載せる上位クエリの件数 */
const QUERIES_PER_PAGE = 3;

/*
 * GSC クエリの分析（カニバリ実測・未カバー・リライト優先度）のしきい値。上と同じく立ち上げ期用に低い。
 */
/** カニバリ（実測）：同じクエリに2記事以上が出ていて、記事側の表示がこれ以上のものだけ */
const CANNIBAL_MIN_IMPR = 5;
/**
 * 未カバーのクエリ：台帳・記事のどのKWとも「語の重なりが薄い」と見なす境界。
 * jaccard は cannibal.ts の WEAK_JACCARD と同じ 0.34（2語どうしで1語共通＝1/3 のすぐ上）。
 * coverB は「KW側のトークンがクエリに何割含まれるか」で、3語KWのうち2語がクエリに入っている（0.67）なら
 * そのKWの守備範囲と見て新KWにしない。4語KWで3語（0.75）から「同じ狙い」と見る。
 */
const UNCOVERED_JACCARD_MAX = 0.34;
const UNCOVERED_COVERB_MAX = 0.75;
/**
 * 3つ目の物差し：クエリの語が KW の文字列に（分かち書きを無視して）何割含まれるか。
 * 台帳の「誕生日プレゼント 彼女 予算 相場 社会人」は「誕生日プレゼント」が1トークンなので、
 * クエリ「誕生日 プレゼント 相場」とは上の2条件でほぼ重ならず、主力記事のクエリが毎週「新KW候補」に化ける。
 * 字面で拾えるぶんはここで塞ぐ（cannibal.ts が見出しルールで同じ穴を塞いでいるのと同じ理屈）。
 */
const UNCOVERED_TEXT_COVER_MAX = 0.75;
const UNCOVERED_LIMIT = 30;
/** リライト優先度：経過日の重みはこの日数で頭打ち（式は buildGscExtraSections のコメント） */
const REWRITE_AGE_CAP_DAYS = 90;
const REWRITE_LIMIT = 10;
/** snapshot に入れるクエリ：記事別の上位と全体の上位の和集合（src/lib/stats.ts の PvSnapshotQuery） */
const SNAPSHOT_QUERIES_PER_PAGE = 5;
const SNAPSHOT_QUERIES_TOP = 100;
/** KW候補用の全量ファイルの上限（クエリ単位） */
const GSC_ALL_QUERIES_LIMIT = 2000;

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
].join(' ');
const GA4_API = 'https://analyticsdata.googleapis.com/v1beta';
const GSC_API = 'https://www.googleapis.com/webmasters/v3';

interface Options {
  dryRun: boolean;
  local: boolean;
  noGa4: boolean;
  noGsc: boolean;
  publish: string;
  date: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { dryRun: false, local: false, noGa4: false, noGsc: false, publish: '', date: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--local') o.local = true;
    else if (a === '--no-ga4') o.noGa4 = true;
    else if (a === '--no-gsc') o.noGsc = true;
    else if (a === '--publish') o.publish = (argv[++i] ?? '').trim();
    else if (a === '--date') o.date = (argv[++i] ?? '').trim();
    else die(`知らないオプション: ${a}`);
  }
  return o;
}

function die(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n===== ${title} =====`);
}

const fmt = (n: number) => n.toLocaleString('ja-JP');
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;
const deltaText = (d: number | null) => (d === null ? '—' : `${d > 0 ? '+' : ''}${d}%`);

/* ────────────────────────────────────────────────
 * D1（wrangler 経由）
 * ──────────────────────────────────────────────── */

/**
 * 複数の文をまとめて1回の wrangler で流し、文ごとの results を返す。
 * wrangler の起動が1回3〜5秒かかるので、クエリの数だけ起動しない。
 * SQL が長いときはファイル経由（コマンドライン長の上限）。put-draft.ts と同じ作り。
 */
function d1Many(sqls: string[], opts: Options): any[][] {
  const sql = sqls.map((s) => s.trim().replace(/;$/, '')).join(';\n') + ';';
  const args = ['d1', 'execute', DB_NAME, opts.local ? '--local' : '--remote', '--json'];
  let tmp = '';
  if (sql.length > 1000) {
    tmp = join(tmpdir(), `anniv-update-pv-${Date.now()}.sql`);
    writeFileSync(tmp, sql, 'utf8');
    args.push('--file', tmp);
  } else {
    args.push('--command', sql);
  }
  const res = spawnSync(process.execPath, [WRANGLER, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  if (res.status !== 0) die(`D1 の実行に失敗した\n${res.stderr || res.stdout}`);
  const out = res.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) die(`D1 の応答を読めなかった\n${out}`);
  let parsed: any[];
  try {
    parsed = JSON.parse(out.slice(start));
  } catch {
    return die(`D1 の応答を読めなかった\n${out}`);
  }
  if (parsed.length !== sqls.length) die(`D1 の応答数が合わない（${sqls.length} 文を流して ${parsed.length} 件）`);
  return parsed.map((r) => r.results ?? []);
}

/** SQL の文字列リテラル。SQLite は '' で ' をエスケープする。 */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface ArticleRow extends KwCsvArticle {
  id: number;
}
/**
 * KW台帳の1行のうち「未カバーのクエリ」の照合に要る列。
 * seed（種KW）は 2026-09-10 の migrations/2026-09-10-keywords-seo.sql で足す列で、本番 D1 に
 * scripts/seo/migrate.ts を当てるまでは無い。同じバッチに入れると1段目ごと落ちて週次が止まるので、
 * 照合に使わない seed はここでは引かない（要るようになったら migrate 済みを確認して足す）。
 */
interface KeywordRow {
  id: number;
  keyword: string;
  axis: string;
  funnel: string;
  status: string;
}
interface EventAgg {
  name: string;
  label: string;
  source: string;
  medium: string;
  n: number;
}

/* ────────────────────────────────────────────────
 * Google（サービスアカウント）
 * ──────────────────────────────────────────────── */

/** `.dev.vars`（KEY=VALUE。値は "…" で囲まれていてもよい）。環境変数があればそちらが勝つ。 */
function readDevVars(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(DEV_VARS)) {
    for (const raw of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  }
  for (const k of ['GA4_PROPERTY_ID', 'GA4_SA_EMAIL', 'GA4_SA_PRIVATE_KEY', 'GSC_SITE_URL']) {
    const v = process.env[k];
    if (v && v.trim()) out[k] = v.trim();
  }
  return out;
}

type GoogleAuth = { ok: true; token: string; propertyId: string; site: string } | { ok: false; reason: string };

/**
 * サービスアカウントの鍵で JWT を作り、アクセストークンに替える（src/lib/ga4.ts と同じ手順の node 版）。
 * 1トークンで GA4 と GSC の両スコープを要求する。GSC 側に権限が無くてもトークン自体は出て、
 * GSC の呼び出しだけ 403 になる（そのときは GSC の段だけ飛ぶ）。
 */
async function googleAuth(): Promise<GoogleAuth> {
  const v = readDevVars();
  const propertyId = (v.GA4_PROPERTY_ID ?? '').trim();
  const email = (v.GA4_SA_EMAIL ?? '').trim();
  const pem = (v.GA4_SA_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  const site = (v.GSC_SITE_URL ?? GSC_SITE_DEFAULT).trim();
  if (!propertyId || !email || !pem) {
    return {
      ok: false,
      reason:
        '.dev.vars に GA4_PROPERTY_ID / GA4_SA_EMAIL / GA4_SA_PRIVATE_KEY が無い（wrangler secret と同じ値を書く。計測設計.md 11章）',
    };
  }
  if (!/^\d+$/.test(propertyId)) return { ok: false, reason: 'GA4_PROPERTY_ID が数字でない（測定IDではなくプロパティID）' };

  const iat = Math.floor(Date.now() / 1000);
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(
    JSON.stringify({ iss: email, scope: GOOGLE_SCOPES, aud: GOOGLE_TOKEN_URL, exp: iat + 3600, iat }),
  )}`;
  let sig: string;
  try {
    sig = createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url');
  } catch (e) {
    return { ok: false, reason: `秘密鍵で署名できない（PEM が壊れている）: ${(e as Error).message}` };
  }
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`,
      }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      return {
        ok: false,
        reason: `トークン取得に失敗: ${data.error ?? res.status} ${data.error_description ?? ''}`.trim(),
      };
    }
    return { ok: true, token: data.access_token, propertyId, site };
  } catch (e) {
    return { ok: false, reason: `トークン取得に失敗（ネットワーク）: ${(e as Error).message}` };
  }
}

type ApiResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

async function postJson<T>(url: string, token: string, body: unknown, pick: (data: any) => T[]): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text)?.error?.message ?? msg;
      } catch {
        /* そのまま */
      }
      return { ok: false, reason: `${res.status} ${msg}` };
    }
    return { ok: true, rows: pick(JSON.parse(text)) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** `/media/<slug>` だけを拾う（一覧・カテゴリ・末尾スラッシュ・クエリ付きは寄せる／落とす）。 */
function slugFromPath(p: string): string | null {
  let path = p;
  try {
    path = decodeURIComponent(p);
  } catch {
    /* そのまま */
  }
  path = (path.split('?')[0] ?? '').split('#')[0]!.replace(/\/+$/, '').toLowerCase();
  const m = path.match(/^\/media\/([a-z0-9-]+)$/);
  return m ? m[1]! : null;
}
function slugFromUrl(u: string): string | null {
  try {
    return slugFromPath(new URL(u).pathname);
  } catch {
    return null;
  }
}

interface Ga4Page {
  pv: number;
  users: number;
  /** 合計エンゲージ秒。平均滞在 = engSec / users */
  engSec: number;
}
interface Ga4Data {
  ok: boolean;
  reason?: string;
  totals: { sessions: number; users: number };
  pages: Map<string, Ga4Page>;
  /** slug → チャネル → セッション */
  channels: Map<string, Map<string, number>>;
}

const GA4_MEDIA_FILTER = {
  filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/media/' } },
};

async function fetchGa4(auth: Extract<GoogleAuth, { ok: true }>, days: number): Promise<Ga4Data> {
  const empty: Ga4Data = { ok: false, totals: { sessions: 0, users: 0 }, pages: new Map(), channels: new Map() };
  const url = `${GA4_API}/properties/${auth.propertyId}:runReport`;
  const pickRows = (d: any) => (d.rows ?? []) as any[];
  const dim = (r: any, i: number): string => r.dimensionValues?.[i]?.value ?? '';
  const num = (r: any, i: number): number => {
    const v = Number(r.metricValues?.[i]?.value ?? '0');
    return Number.isFinite(v) ? v : 0;
  };
  const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];

  const [pages, channels, totals] = await Promise.all([
    postJson(
      url,
      auth.token,
      {
        dateRanges,
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'userEngagementDuration' }],
        dimensionFilter: GA4_MEDIA_FILTER,
        limit: 1000,
      },
      pickRows,
    ),
    postJson(
      url,
      auth.token,
      {
        dateRanges,
        dimensions: [{ name: 'pagePath' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: GA4_MEDIA_FILTER,
        limit: 2000,
      },
      pickRows,
    ),
    postJson(
      url,
      auth.token,
      {
        dateRanges,
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        dimensionFilter: GA4_MEDIA_FILTER,
      },
      pickRows,
    ),
  ]);
  if (!pages.ok) return { ...empty, reason: pages.reason };

  const out: Ga4Data = { ...empty, ok: true };
  for (const r of pages.rows) {
    const slug = slugFromPath(dim(r, 0));
    if (!slug) continue;
    const cur = out.pages.get(slug) ?? { pv: 0, users: 0, engSec: 0 };
    cur.pv += num(r, 0);
    cur.users += num(r, 1);
    cur.engSec += num(r, 2);
    out.pages.set(slug, cur);
  }
  if (channels.ok) {
    for (const r of channels.rows) {
      const slug = slugFromPath(dim(r, 0));
      if (!slug) continue;
      let m = out.channels.get(slug);
      if (!m) out.channels.set(slug, (m = new Map()));
      const ch = dim(r, 1) || '(other)';
      m.set(ch, (m.get(ch) ?? 0) + num(r, 0));
    }
  }
  if (totals.ok && totals.rows[0]) {
    out.totals = { sessions: num(totals.rows[0], 0), users: num(totals.rows[0], 1) };
  }
  return out;
}

interface GscPage {
  clicks: number;
  impressions: number;
  /** 表示数で重み付けした平均順位 */
  position: number;
}
interface GscQuery extends GscPage {
  query: string;
  slug: string;
}
interface GscData {
  ok: boolean;
  reason?: string;
  site: string;
  range: { start: string; end: string };
  totals: GscPage;
  pages: Map<string, GscPage>;
  /** ページ×クエリの生データ（/media/ 配下のみ） */
  queries: GscQuery[];
}

/** GSC の集計期間。--publish 側でも同じ式で復元できるように関数にしておく。 */
function gscRange(today: string, days: number): { start: string; end: string } {
  const end = shiftYmd(today, -GSC_LAG_DAYS);
  return { start: shiftYmd(end, -(days - 1)), end };
}

async function fetchGsc(auth: Extract<GoogleAuth, { ok: true }>, today: string, days: number): Promise<GscData> {
  const range = gscRange(today, days);
  const empty: GscData = {
    ok: false,
    site: auth.site,
    range,
    totals: { clicks: 0, impressions: 0, position: 0 },
    pages: new Map(),
    queries: [],
  };
  const url = `${GSC_API}/sites/${encodeURIComponent(auth.site)}/searchAnalytics/query`;
  const mediaFilter = {
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/media/' }] }],
  };
  type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
  const pick = (d: any) => (d.rows ?? []) as Row[];

  const [pages, queries] = await Promise.all([
    postJson(url, auth.token, { startDate: range.start, endDate: range.end, dimensions: ['page'], rowLimit: 1000, ...mediaFilter }, pick),
    postJson(
      url,
      auth.token,
      { startDate: range.start, endDate: range.end, dimensions: ['page', 'query'], rowLimit: 5000, ...mediaFilter },
      pick,
    ),
  ]);
  if (!pages.ok) return { ...empty, reason: pages.reason };

  const out: GscData = { ...empty, ok: true };
  let posWeighted = 0;
  for (const r of pages.rows) {
    const slug = slugFromUrl(r.keys[0] ?? '');
    if (!slug) continue;
    const cur = out.pages.get(slug) ?? { clicks: 0, impressions: 0, position: 0 };
    // 同じ記事が末尾スラッシュ違いなどで複数行に割れることがあるので、順位は表示数で加重して足す
    const w = cur.impressions + r.impressions;
    cur.position = w > 0 ? (cur.position * cur.impressions + r.position * r.impressions) / w : 0;
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    out.pages.set(slug, cur);
    out.totals.clicks += r.clicks;
    out.totals.impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  out.totals.position = out.totals.impressions > 0 ? posWeighted / out.totals.impressions : 0;
  if (queries.ok) {
    for (const r of queries.rows) {
      const slug = slugFromUrl(r.keys[0] ?? '');
      if (!slug) continue;
      out.queries.push({ query: r.keys[1] ?? '', slug, clicks: r.clicks, impressions: r.impressions, position: r.position });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────
 * 履歴（前回比の基準・ダッシュボードに入れる断面の元）
 * ──────────────────────────────────────────────── */

const HISTORY_HEADER = [
  '日付',
  'slug',
  'KW',
  '軸',
  '累計PV',
  `直近${WINDOW_DAYS}日PV`,
  `前${WINDOW_DAYS}日PV`,
  'GA4_PV',
  'GA4_ユーザー',
  'GSC_クリック',
  'GSC_表示',
  'GSC_順位',
];

/** RFC 4180 の最小パーサ（この履歴は自分で書いたものしか読まない）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

interface HistoryRow {
  ymd: string;
  slug: string;
  pv: number;
  prevPv: number;
  total: number;
  ga4Pv: number | null;
  ga4Users: number | null;
  gscClicks: number | null;
  gscImpr: number | null;
  gscPos: number | null;
}

function readHistory(): HistoryRow[] {
  if (!existsSync(HISTORY_PATH)) return [];
  const rows = parseCsv(readFileSync(HISTORY_PATH, 'utf8'));
  const header = rows[0] ?? [];
  const idx = (name: string) => header.indexOf(name);
  const iY = idx('日付');
  const iS = idx('slug');
  if (iY < 0 || iS < 0) return [];
  const iT = idx('累計PV');
  const iP = idx(`直近${WINDOW_DAYS}日PV`);
  const iQ = idx(`前${WINDOW_DAYS}日PV`);
  const iGp = idx('GA4_PV');
  const iGu = idx('GA4_ユーザー');
  const iC = idx('GSC_クリック');
  const iI = idx('GSC_表示');
  const iPos = idx('GSC_順位');
  const n = (r: string[], i: number) => (i >= 0 ? Number(r[i] ?? '') || 0 : 0);
  /** 空欄は「その系統を取れなかった」なので 0 ではなく null にする（0 は「取れたが0」）。 */
  const opt = (r: string[], i: number) => (i >= 0 && (r[i] ?? '') !== '' ? Number(r[i]) || 0 : null);
  return rows.slice(1).map((r) => ({
    ymd: r[iY] ?? '',
    slug: r[iS] ?? '',
    total: n(r, iT),
    pv: n(r, iP),
    prevPv: n(r, iQ),
    ga4Pv: opt(r, iGp),
    ga4Users: opt(r, iGu),
    gscClicks: opt(r, iC),
    gscImpr: opt(r, iI),
    gscPos: opt(r, iPos),
  }));
}

/* ────────────────────────────────────────────────
 * ファクトシート
 * ──────────────────────────────────────────────── */

function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '（該当なし）';
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

/* ────────────────────────────────────────────────
 * GSC クエリの分析（純粋関数）
 *
 * ここは D1 にもファイルにも触らない。GSC が取れる環境がローカルに無いので、
 * `node --experimental-strip-types -e` から import して固定データで出力を確かめられるように export している
 * （末尾の main() は直接実行のときだけ回る）。
 * ──────────────────────────────────────────────── */

/** 分析節に要る記事の最小限。perf（公開記事）から作る。 */
export interface GscExtraArticle {
  slug: string;
  keyword: string;
  /** 公開日（JST の YYYY-MM-DD）。無ければ null */
  pubYmd: string | null;
  /** 最終更新日（同上） */
  updYmd: string | null;
}
/** 台帳側。dropped を除く判断だけするので keyword と status があればよい。 */
export interface GscExtraKeyword {
  keyword: string;
  status: string;
}

/** 小数1桁。順位は表示加重の平均なので桁が伸びる。JSON と表に出す前に丸める。 */
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * クエリ×記事の行を (query, slug) で束ねる。
 * GSC は末尾スラッシュ違いなどで同じ記事が複数の page 行に割れて返り、slug に寄せた時点で重複する。
 * 順位は表示数で加重して合成する（fetchGsc のページ側と同じ式）。
 */
export function aggregateQueryRows(rows: GscQuery[]): GscQuery[] {
  const by = new Map<string, GscQuery>();
  for (const r of rows) {
    const key = `${r.query} ${r.slug}`;
    const cur = by.get(key);
    if (!cur) {
      by.set(key, { ...r });
      continue;
    }
    const w = cur.impressions + r.impressions;
    cur.position = w > 0 ? (cur.position * cur.impressions + r.position * r.impressions) / w : 0;
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
  }
  return [...by.values()];
}

export interface QueryAgg {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  /** そのクエリで出ている記事（表示の多い順） */
  slugs: string[];
}

/** クエリ単位（記事横断）に束ねる。「未カバーのクエリ」と KW候補用の全量ファイルの元。表示の多い順。 */
export function aggregateByQuery(rows: GscQuery[]): QueryAgg[] {
  const by = new Map<string, QueryAgg & { perSlug: Map<string, number> }>();
  for (const r of aggregateQueryRows(rows)) {
    const cur = by.get(r.query) ?? { query: r.query, clicks: 0, impressions: 0, position: 0, slugs: [], perSlug: new Map() };
    const w = cur.impressions + r.impressions;
    cur.position = w > 0 ? (cur.position * cur.impressions + r.position * r.impressions) / w : 0;
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.perSlug.set(r.slug, (cur.perSlug.get(r.slug) ?? 0) + r.impressions);
    by.set(r.query, cur);
  }
  return [...by.values()]
    .map(({ perSlug, ...q }) => ({ ...q, slugs: [...perSlug.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s) }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query));
}

/**
 * snapshot（pv_reports.snapshot_json）に入れるクエリ。
 * 5000行を全部入れると D1 の1行が重くなり画面でも読めないので、「記事別の上位5件」と「全体の上位100件」の
 * 和集合に間引く。記事別を残すのは、表示の少ない新しい記事が全体上位に1件も入らず画面から消えるのを避けるため。
 */
export function buildSnapshotQueries(rows: GscQuery[]): PvSnapshotQuery[] {
  const sorted = aggregateQueryRows(rows).sort(
    (a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query),
  );
  const key = (q: GscQuery) => `${q.query} ${q.slug}`;
  const picked = new Map<string, GscQuery>();
  const perSlug = new Map<string, number>();
  for (const q of sorted) {
    const n = perSlug.get(q.slug) ?? 0;
    if (n >= SNAPSHOT_QUERIES_PER_PAGE) continue;
    perSlug.set(q.slug, n + 1);
    picked.set(key(q), q);
  }
  for (const q of sorted.slice(0, SNAPSHOT_QUERIES_TOP)) picked.set(key(q), q);
  return [...picked.values()]
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
    .map((q) => ({ query: q.query, slug: q.slug, clicks: q.clicks, impressions: q.impressions, position: round1(q.position) }));
}

/**
 * ファクトシートの「GSC クエリ」節に足す3節（カニバリ実測／未カバーのクエリ／リライト優先度）。
 * 戻りは Markdown の行。既存の「### 記事別 上位クエリ」の後ろに置く前提で、見出しは ### から始める。
 * GSC が取れていない回は「出せない」の1行だけ返す（節が消えると「無い」と「見落とし」の区別がつかない）。
 */
export function buildGscExtraSections(
  gsc: GscData | null,
  articles: GscExtraArticle[],
  keywords: GscExtraKeyword[],
  today: string,
): string[] {
  const L: string[] = [];
  if (!gsc || !gsc.ok) {
    L.push('### カニバリ（実測）／未カバーのクエリ／リライト優先度', '');
    L.push('- GSC が無いので出せない（Search Console が取れた回に出る。鍵の置き方は メディア方針/計測設計.md 11章）', '');
    return L;
  }
  const rows = aggregateQueryRows(gsc.queries);
  const kwOf = new Map(articles.map((a) => [a.slug, a.keyword]));

  /* ── カニバリ（実測）── */
  const cannibal = gscCannibal(rows, { minImpressions: CANNIBAL_MIN_IMPR });
  L.push(`### カニバリ（実測。同じクエリに2記事以上が出ている・記事側の表示≥${CANNIBAL_MIN_IMPR}）`, '');
  if (cannibal.length === 0) {
    L.push('- なし', '');
  } else {
    L.push(
      mdTable(
        ['クエリ', '表示合計', '記事（slug・表示・順位・クリック）'],
        cannibal.map((c) => [
          c.query,
          c.impressions,
          c.pages.map((p) => `${p.slug}（表示 ${p.impressions}・順位 ${p.position.toFixed(1)}・クリック ${p.clicks}）`).join(' / '),
        ]),
      ),
      '',
    );
    L.push(
      '- 順位が近い2本は検索意図が同じ＝統合か、片方の見出しから該当KWを外す候補。順位が離れていれば Google が使い分けているので急がない',
      '',
    );
  }

  /* ── 未カバーのクエリ（新KW候補）── */
  // 照合相手は台帳（dropped 以外）と公開記事の keyword。トークンに落として、どれとも重なりが薄い語だけ残す。
  // compact は空白を抜いた KW 文字列（部分一致用。textHasToken は同義グループの全メンバーで当てる）
  const targets = [
    ...keywords.filter((k) => k.status !== 'dropped').map((k) => k.keyword),
    ...articles.map((a) => a.keyword),
  ]
    .map((kw) => ({ tokens: tokenize(kw), compact: kw.replace(/[\s　]+/g, '') }))
    .filter((t) => t.tokens.length > 0);
  const uncovered = aggregateByQuery(rows)
    .filter((q) => q.impressions >= GSC_MISS_MIN_IMPR)
    .filter((q) => {
      const tq = tokenize(q.query);
      if (tq.length === 0) return false; // ストップワードだけの語は判定できない
      return targets.every((t) => {
        const o = overlap(tq, t.tokens);
        return (
          o.jaccard < UNCOVERED_JACCARD_MAX &&
          o.coverB < UNCOVERED_COVERB_MAX &&
          textCoverage(t.compact, tq).ratio < UNCOVERED_TEXT_COVER_MAX
        );
      });
    })
    .slice(0, UNCOVERED_LIMIT);
  L.push(
    `### 未カバーのクエリ（新KW候補。表示≥${GSC_MISS_MIN_IMPR} で、台帳（dropped 以外）と記事のどのKWとも語の重なりが薄いもの・上位${UNCOVERED_LIMIT}）`,
    '',
  );
  if (uncovered.length === 0) {
    L.push('- なし', '');
  } else {
    L.push(
      mdTable(
        ['クエリ', '表示', 'クリック', '順位', '今出ている記事（slug）'],
        uncovered.map((q) => [q.query, q.impressions, q.clicks, q.position.toFixed(1), q.slugs.join(' / ')]),
      ),
      '',
    );
  }
  L.push(
    `- \`/anniv-pick-keyword\` の種KW候補（keyword-selection.md 7章）。判定は tokenize した語の重なりで jaccard<${UNCOVERED_JACCARD_MAX} かつ KW側の被覆<${UNCOVERED_COVERB_MAX} かつ クエリの語のKW文字列への部分一致<${UNCOVERED_TEXT_COVER_MAX}（src/lib/seo/tokens.ts）。「今出ている記事」があるのは、その記事が拾ってはいるが狙ってはいない語`,
    '',
  );

  /* ── リライト優先度 ── */
  // スコア＝striking distance（順位 STRIKE_POS_MIN〜MAX・表示≥STRIKE_MIN_IMPR）のクエリの表示合計 × (1 + min(経過日/90, 1))。
  // 公開直後は順位がまだ動いている最中で、同じ表示数でも「待てば上がる」余地がある。
  // 90日たって同じ位置に居座っているものほど、加筆しないと動かない＝手を入れる価値が高い。重みは 1〜2 倍の範囲に収める。
  const scored = articles
    .map((a) => {
      const mine = rows.filter(
        (q) => q.slug === a.slug && q.impressions >= STRIKE_MIN_IMPR && q.position >= STRIKE_POS_MIN && q.position <= STRIKE_POS_MAX,
      );
      const impr = mine.reduce((n, q) => n + q.impressions, 0);
      const age = a.pubYmd ? daysBetween(a.pubYmd, today) : null;
      const upd = a.updYmd ? daysBetween(a.updYmd, today) : null;
      const weight = 1 + Math.min(1, Math.max(0, age ?? 0) / REWRITE_AGE_CAP_DAYS);
      return { a, score: Math.round(impr * weight), n: mine.length, impr, age, upd };
    })
    .filter((s) => s.n > 0)
    .sort((x, y) => y.score - x.score || y.impr - x.impr)
    .slice(0, REWRITE_LIMIT);
  L.push(
    `### リライト優先度（striking distance の表示合計 × (1 + 経過日/${REWRITE_AGE_CAP_DAYS}、上限1.0)・上位${REWRITE_LIMIT}）`,
    '',
  );
  if (scored.length === 0) {
    L.push(`- なし（順位${STRIKE_POS_MIN}〜${STRIKE_POS_MAX}・表示≥${STRIKE_MIN_IMPR} のクエリを持つ記事が無い）`, '');
  } else {
    L.push(
      mdTable(
        ['記事（KW）', 'slug', 'スコア', 'striking のクエリ数', '表示合計', '公開からの日数', '最終更新からの日数'],
        scored.map((s) => [kwOf.get(s.a.slug) ?? s.a.keyword, s.a.slug, s.score, s.n, s.impr, s.age ?? '—', s.upd ?? '—']),
      ),
      '',
    );
  }
  L.push(
    '- 上位ほど、新規1本より既存記事の加筆・内部リンクのほうが ROI が高い可能性（keyword-selection.md 7章）。`/anniv-rewrite-article <KW>` の候補順',
    '',
  );
  return L;
}

/**
 * --publish が読む、通常実行が書いた GSC クエリの断面。
 * PV履歴.csv にはクエリ別の列が無い（1記事1行の作り）ので、別ファイルで持ち越す。
 * 無い・壊れている・日付が違う（別の日の実行分）ときは空にする。断面の ymd と中身の日付が食い違うと、画面の注記が嘘になるため。
 */
function readSnapshotQueries(ymd: string): PvSnapshotQuery[] {
  if (!existsSync(GSC_QUERIES_SNAPSHOT_PATH)) return [];
  let parsed: { ymd?: unknown; rows?: unknown };
  try {
    parsed = JSON.parse(readFileSync(GSC_QUERIES_SNAPSHOT_PATH, 'utf8').replace(/^﻿/, ''));
  } catch {
    console.log(`警告: ${GSC_QUERIES_SNAPSHOT_PATH} を読めなかった。クエリの断面は空で入れる`);
    return [];
  }
  if (parsed.ymd !== ymd) {
    console.log(`警告: ${GSC_QUERIES_SNAPSHOT_PATH} は ${String(parsed.ymd ?? '?')} の分（入れるのは ${ymd}）。クエリの断面は空で入れる`);
    return [];
  }
  if (!Array.isArray(parsed.rows)) return [];
  return parsed.rows
    .filter(
      (q): q is PvSnapshotQuery =>
        !!q && typeof q === 'object' && typeof (q as PvSnapshotQuery).query === 'string' && typeof (q as PvSnapshotQuery).slug === 'string',
    )
    .map((q) => ({
      query: q.query,
      slug: q.slug,
      clicks: Number(q.clicks) || 0,
      impressions: Number(q.impressions) || 0,
      position: Number(q.position) || 0,
    }));
}

/* ────────────────────────────────────────────────
 * --publish：週次レポートを D1 に入れる
 * ──────────────────────────────────────────────── */

function publish(opts: Options): void {
  const path = resolve(ROOT, opts.publish);
  if (!existsSync(path)) die(`レポートが無い: ${path}`);
  const ymd = opts.date || basename(path).match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) die('日付が分からない。ファイル名に YYYY-MM-DD を入れるか --date で指定する');

  const reportMd = readFileSync(path, 'utf8').replace(/^﻿/, '').trim();
  if (!reportMd) die('レポートが空');

  // その日の断面は PV履歴.csv から復元する（通常実行が書いた行）。
  const rows = readHistory().filter((h) => h.ymd === ymd);
  if (rows.length === 0) {
    console.log(`警告: PV履歴.csv に ${ymd} の行が無い。先に通常実行を回していないと GA4 / GSC の列は出ない`);
  }
  const hasGa4 = rows.some((r) => r.ga4Pv !== null);
  const hasGsc = rows.some((r) => r.gscImpr !== null);
  // クエリの断面は PV履歴.csv に無いので gsc-queries.json から。GSC が無い回（--no-gsc で回し直した日など）は
  // 同じ日のファイルが残っていても入れない（gsc:false なのにクエリだけ出る画面になる）
  const queries = hasGsc ? readSnapshotQueries(ymd) : [];
  const snapshot: PvSnapshot = {
    ymd,
    ga4: hasGa4,
    gsc: hasGsc,
    gscRange: hasGsc ? gscRange(ymd, WINDOW_DAYS) : null,
    rows: rows.map(
      (r): PvSnapshotRow => ({
        slug: r.slug,
        ga4Pv: r.ga4Pv,
        ga4Users: r.ga4Users,
        gscClicks: r.gscClicks,
        gscImpr: r.gscImpr,
        gscPos: r.gscPos,
      }),
    ),
    queries,
  };

  const sql = `INSERT INTO pv_reports (ymd, report_md, snapshot_json, created_at)
VALUES (${lit(ymd)}, ${lit(reportMd)}, ${lit(JSON.stringify(snapshot))}, ${lit(new Date().toISOString())})
ON CONFLICT(ymd) DO UPDATE SET report_md = excluded.report_md, snapshot_json = excluded.snapshot_json, created_at = excluded.created_at`;

  if (opts.dryRun) {
    console.log(
      `dry-run: ${ymd} のレポート（${reportMd.length} 字）と断面 ${rows.length} 行・クエリ ${queries.length} 行を pv_reports に入れる予定`,
    );
    return;
  }
  d1Many([sql], opts);
  console.log(
    `pv_reports に入れた: ${ymd}（本文 ${reportMd.length} 字 / 断面 ${rows.length} 行 / クエリ ${queries.length} 行 / GA4 ${hasGa4 ? 'あり' : '無し'} / GSC ${hasGsc ? 'あり' : '無し'}）`,
  );
  console.log('https://anniv.gift/admin/stats を開けば出ている（デプロイは要らない）。');
}

/* ────────────────────────────────────────────────
 * main
 * ──────────────────────────────────────────────── */

interface PerfRow {
  article: ArticleRow;
  perf: KwCsvPerf;
  pubYmd: string | null;
  ageDays: number | null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.publish) {
    publish(opts);
    return;
  }

  const today = isoToYmd(new Date().toISOString())!;
  const curYmds = ymdRange(today, WINDOW_DAYS);
  const prevYmds = ymdRange(shiftYmd(today, -WINDOW_DAYS), WINDOW_DAYS);
  const since28 = curYmds[0]!;
  const since56 = prevYmds[0]!;

  console.log(`Anniv PV更新  ${today}（JST） ${opts.dryRun ? '[dry-run: ファイルは書かない]' : ''}`);

  /* ── 1. D1 ── */
  section(`1/3 D1（${opts.local ? 'ローカル' : '本番'}）から記事・自前PV・導線イベント・KW台帳`);
  const [articlesR, pvRowsR, pvTotR, firstR, evR, evPrevR, keywordsR] = d1Many(
    [
      `SELECT id, slug, title, keyword, axis, funnel, status, is_ad, published_at, updated_at
       FROM articles ORDER BY COALESCE(published_at, updated_at) DESC, id DESC`,
      `SELECT article_id, ymd, count FROM pageviews WHERE ymd >= '${since56}'`,
      `SELECT article_id, SUM(count) AS n FROM pageviews GROUP BY article_id`,
      `SELECT MIN(ymd) AS ymd FROM pageviews`,
      `SELECT name, label, source, medium, SUM(count) AS n FROM event_daily
       WHERE ymd >= '${since28}' GROUP BY name, label, source, medium ORDER BY n DESC`,
      `SELECT name, SUM(count) AS n FROM event_daily
       WHERE ymd >= '${since56}' AND ymd < '${since28}' GROUP BY name`,
      // KW台帳。「未カバーのクエリ」（GSC にあるのに狙っていない語）の照合相手。seed を引かない理由は KeywordRow のコメント
      `SELECT id, keyword, axis, funnel, status FROM keywords ORDER BY id`,
    ],
    opts,
  ) as [
    ArticleRow[],
    Array<{ article_id: number; ymd: string; count: number }>,
    Array<{ article_id: number; n: number }>,
    Array<{ ymd: string | null }>,
    EventAgg[],
    Array<{ name: string; n: number }>,
    KeywordRow[],
  ];

  const articles = articlesR;
  const published = articles.filter((a) => a.status === 'published');
  const drafts = articles.length - published.length;
  const perArticle = pivotByArticle(pvRowsR);
  const totals = new Map(pvTotR.map((r) => [r.article_id, r.n]));
  const firstYmd = firstR[0]?.ymd ?? null;
  const measuredDays = firstYmd ? daysBetween(firstYmd, today) + 1 : 0;
  const canJudge = measuredDays >= WINDOW_DAYS;

  const perf: PerfRow[] = published
    .map((a) => {
      const pubYmd = isoToYmd(a.published_at);
      return {
        article: a,
        pubYmd,
        ageDays: pubYmd ? daysBetween(pubYmd, today) : null,
        perf: windowPerf({
          publishedAt: a.published_at,
          today,
          by: perArticle.get(a.id),
          curYmds,
          prevYmds,
          total: totals.get(a.id) ?? 0,
          canJudge,
        }),
      };
    })
    .sort((x, y) => y.perf.pv - x.perf.pv || y.perf.total - x.perf.total);

  // サイト全体は記事別の合計ではなく生の行から足す（削除済み記事の分も含めて、/admin/stats と揃える）
  const curSet = new Set(curYmds);
  let pvCur = 0;
  let pvPrev = 0;
  for (const r of pvRowsR) {
    if (curSet.has(r.ymd)) pvCur += r.count;
    else pvPrev += r.count;
  }
  const pvAll = pvTotR.reduce((n, r) => n + r.n, 0);

  const CV = new Set(['form_complete', 'line_add_click']);
  const evByName = new Map<string, number>();
  const evBySource = new Map<string, { events: number; cv: number }>();
  const cvByLabel = new Map<string, number>();
  for (const e of evR) {
    evByName.set(e.name, (evByName.get(e.name) ?? 0) + e.n);
    const s = evBySource.get(e.source) ?? { events: 0, cv: 0 };
    s.events += e.n;
    if (CV.has(e.name)) {
      s.cv += e.n;
      const k = `${e.name} @ ${e.label || '(no label)'}`;
      cvByLabel.set(k, (cvByLabel.get(k) ?? 0) + e.n);
    }
    evBySource.set(e.source, s);
  }
  const cvCur = [...evByName.entries()].filter(([n]) => CV.has(n)).reduce((n, [, v]) => n + v, 0);
  const cvPrev = evPrevR.filter((r) => CV.has(r.name)).reduce((n, r) => n + r.n, 0);

  const keywordsLive = keywordsR.filter((k) => k.status !== 'dropped').length;
  console.log(`  公開 ${published.length} 本 / 下書き ${drafts} 本 / KW台帳 ${keywordsR.length} 件（dropped 除く ${keywordsLive} 件）`);
  console.log(
    `  自前PV: 直近${WINDOW_DAYS}日 ${fmt(pvCur)}（前${WINDOW_DAYS}日 ${fmt(pvPrev)}、${deltaText(deltaPct(pvCur, pvPrev))}）/ 累計 ${fmt(pvAll)}`,
  );
  console.log(`  計測開始 ${firstYmd ?? '—'}（${measuredDays}日目）→ 自動判定 ${canJudge ? '出す' : `出さない（${WINDOW_DAYS}日未満）`}`);
  console.log(`  CV（form_complete + line_add_click）: 直近${WINDOW_DAYS}日 ${cvCur} / 前${WINDOW_DAYS}日 ${cvPrev}`);

  /* ── 2・3. Google ── */
  let ga4: Ga4Data | null = null;
  let gsc: GscData | null = null;
  let authReason = '';
  if (!opts.noGa4 || !opts.noGsc) {
    const auth = await googleAuth();
    if (!auth.ok) {
      authReason = auth.reason;
      section('2/3 GA4・3/3 Search Console → スキップ');
      console.log(`  ${auth.reason}`);
    } else {
      if (!opts.noGa4) {
        section(`2/3 GA4（/media/ 配下・直近${WINDOW_DAYS}日）`);
        ga4 = await fetchGa4(auth, WINDOW_DAYS);
        if (ga4.ok) {
          console.log(`  セッション ${fmt(ga4.totals.sessions)} / ユーザー ${fmt(ga4.totals.users)} / ページ別 ${ga4.pages.size} 本`);
        } else {
          console.log(`  取れなかった: ${ga4.reason}`);
        }
      }
      if (!opts.noGsc) {
        section(`3/3 Search Console（${auth.site} の /media/ 配下）`);
        gsc = await fetchGsc(auth, today, WINDOW_DAYS);
        if (gsc.ok) {
          console.log(
            `  ${gsc.range.start}〜${gsc.range.end}: クリック ${fmt(gsc.totals.clicks)} / 表示 ${fmt(gsc.totals.impressions)} / 平均順位 ${gsc.totals.position.toFixed(1)} / ページ ${gsc.pages.size} 本 / クエリ行 ${gsc.queries.length}`,
          );
        } else {
          console.log(`  取れなかった: ${gsc.reason}`);
          console.log(
            '  → Search Console の「設定 → ユーザーと権限」にサービスアカウントのメールを追加し、GCP で Search Console API を有効にする（計測設計.md 11章）',
          );
        }
      }
    }
  }

  /* ── ランキング（コンソール） ── */
  section(`記事別ランキング（自前PV 直近${WINDOW_DAYS}日 降順）`);
  const g = (slug: string) => ga4?.pages.get(slug);
  const s = (slug: string) => gsc?.pages.get(slug);
  console.log(
    [
      '#'.padStart(2),
      `${WINDOW_DAYS}日`.padStart(5),
      '前期'.padStart(5),
      '増減'.padStart(6),
      '累計'.padStart(5),
      'GA4'.padStart(5),
      'GSCク'.padStart(5),
      'GSC表'.padStart(6),
      '順位'.padStart(5),
      '判定'.padEnd(6),
      '公開日'.padEnd(10),
      'KW',
    ].join(' '),
  );
  perf.forEach((p, i) => {
    const gg = g(p.article.slug);
    const ss = s(p.article.slug);
    console.log(
      [
        String(i + 1).padStart(2),
        String(p.perf.pv).padStart(5),
        String(p.perf.prevPv).padStart(5),
        deltaText(p.perf.delta).padStart(6),
        String(p.perf.total).padStart(5),
        (gg ? String(gg.pv) : '—').padStart(5),
        (ss ? String(ss.clicks) : '—').padStart(5),
        (ss ? String(ss.impressions) : '—').padStart(6),
        (ss && ss.impressions > 0 ? ss.position.toFixed(1) : '—').padStart(5),
        (p.perf.flag || '—').padEnd(6),
        (p.pubYmd ?? '—').padEnd(10),
        p.article.keyword,
      ].join(' '),
    );
  });

  /* ── 履歴と前回比 ── */
  const history = readHistory();
  const prevDates = [...new Set(history.map((h) => h.ymd))].filter((d) => d < today).sort();
  const prevDate = prevDates[prevDates.length - 1] ?? null;
  const prevBySlug = new Map(history.filter((h) => h.ymd === prevDate).map((h) => [h.slug, h]));

  const todayRows = perf.map((p) => {
    const gg = g(p.article.slug);
    const ss = s(p.article.slug);
    return [
      today,
      p.article.slug,
      p.article.keyword,
      axisShort(p.article.axis),
      String(p.perf.total),
      String(p.perf.pv),
      String(p.perf.prevPv),
      ga4?.ok ? String(gg?.pv ?? 0) : '',
      ga4?.ok ? String(gg?.users ?? 0) : '',
      gsc?.ok ? String(ss?.clicks ?? 0) : '',
      gsc?.ok ? String(ss?.impressions ?? 0) : '',
      gsc?.ok ? (ss && ss.impressions > 0 ? ss.position.toFixed(1) : '0') : '',
    ];
  });

  /* ── 台帳との突き合わせ（情報だけ） ── */
  const oldSlugs = new Set<string>();
  if (existsSync(CSV_PATH)) {
    const old = parseCsv(readFileSync(CSV_PATH, 'utf8'));
    const iUrl = (old[0] ?? []).indexOf('URL');
    if (iUrl >= 0) {
      for (const r of old.slice(1)) {
        const sl = slugFromUrl(r[iUrl] ?? '');
        if (sl) oldSlugs.add(sl);
      }
    }
  }
  const missingInCsv = published.filter((a) => !oldSlugs.has(a.slug)).map((a) => a.slug);

  /* ── ファクトシート ── */
  const L: string[] = [];
  L.push(`# 現状ファクトシート（${today} 自動生成）`, '');
  L.push(
    '`scripts/update-pv.ts` が毎回の実データ（D1 の自前PV・導線イベント / GA4 / Search Console / PV履歴.csv）から再生成する**読み取り専用**の分析材料。',
    '週次レポートは**このファイルだけ**を見てゼロから書く。前回のレポートは開かない（焼き増し防止）。',
    '前回比は「前回比」節に機械計算で出ているので、各節は**今この数値が何を意味するか**に集中する。',
    '',
  );

  L.push('## 計測の状態', '');
  L.push(
    `- 自前PV（ビーコン）: 計測開始 ${firstYmd ?? '—'}、今日で ${measuredDays} 日目。自動判定（下降／伸び悩み）: **${canJudge ? '出す' : `出さない（${WINDOW_DAYS}日未満）`}**`,
  );
  L.push(
    `- 自動判定の定義: 下降＝直近${WINDOW_DAYS}日が前${WINDOW_DAYS}日の70%未満（前期30PV以上のみ）／伸び悩み＝公開${STALE_AFTER_DAYS}日超で直近${WINDOW_DAYS}日が20PV未満`,
  );
  if (opts.noGa4) L.push('- GA4: `--no-ga4` で飛ばした');
  else if (ga4?.ok) L.push(`- GA4: 取得OK（/media/ 配下・直近${WINDOW_DAYS}日）`);
  else L.push(`- GA4: **取れていない**（${ga4?.reason ?? authReason}）`);
  if (opts.noGsc) L.push('- Search Console: `--no-gsc` で飛ばした');
  else if (gsc?.ok) {
    L.push(`- Search Console: 取得OK（${gsc.site}、${gsc.range.start}〜${gsc.range.end}。直近${GSC_LAG_DAYS}日は未確定なので外している）`);
  } else L.push(`- Search Console: **取れていない**（${gsc?.reason ?? authReason}）`);
  L.push('- 3系統の数字は必ずズレる。突き合わせない。自前PV＝記事どうしの相対比較、GA4＝流入元と滞在、GSC＝検索での立ち位置', '');

  L.push(`## 全体サマリー（直近${WINDOW_DAYS}日）`, '');
  L.push(
    `- 公開 **${published.length} 本**（下書き ${drafts} 本）。公開${STALE_AFTER_DAYS}日超: ${perf.filter((p) => (p.ageDays ?? 0) >= STALE_AFTER_DAYS).length} 本 / 公開14日以内（様子見）: ${perf.filter((p) => (p.ageDays ?? 0) < 14).length} 本`,
  );
  L.push(`- 自前PV: **${fmt(pvCur)}**（前${WINDOW_DAYS}日 ${fmt(pvPrev)}、${deltaText(deltaPct(pvCur, pvPrev))}）/ 累計 ${fmt(pvAll)}`);
  if (perf.length) {
    const top = perf[0]!;
    L.push(
      `- 上位3記事のシェア: ${pvCur > 0 ? pct(perf.slice(0, 3).reduce((n, p) => n + p.perf.pv, 0) / pvCur, 0) : '—'}（1位「${top.article.keyword}」${top.perf.pv}PV）`,
    );
  }
  if (ga4?.ok) L.push(`- GA4（/media/）: セッション **${fmt(ga4.totals.sessions)}** / ユーザー ${fmt(ga4.totals.users)}`);
  if (gsc?.ok) {
    const ctr = gsc.totals.impressions > 0 ? gsc.totals.clicks / gsc.totals.impressions : 0;
    L.push(
      `- GSC（/media/）: クリック **${fmt(gsc.totals.clicks)}** / 表示 ${fmt(gsc.totals.impressions)} / CTR ${pct(ctr)} / 平均順位 ${gsc.totals.position.toFixed(1)}`,
    );
  }
  L.push(`- CV（form_complete + line_add_click、自前計測）: **${cvCur}**（前${WINDOW_DAYS}日 ${cvPrev}）— 本命指標（メディア戦略.md 6章）`, '');

  L.push('## 軸別', '');
  L.push(
    mdTable(
      ['軸', '公開', `直近${WINDOW_DAYS}日PV`, 'シェア', 'GA4 PV', 'GSCクリック', 'GSC表示'],
      AXES.map((ax) => {
        const rows = perf.filter((p) => p.article.axis === ax.slug);
        const pv = rows.reduce((n, p) => n + p.perf.pv, 0);
        const gpv = rows.reduce((n, p) => n + (g(p.article.slug)?.pv ?? 0), 0);
        const gc = rows.reduce((n, p) => n + (s(p.article.slug)?.clicks ?? 0), 0);
        const gi = rows.reduce((n, p) => n + (s(p.article.slug)?.impressions ?? 0), 0);
        return [ax.name, rows.length, pv, pvCur > 0 ? pct(pv / pvCur, 0) : '—', ga4?.ok ? gpv : '—', gsc?.ok ? gc : '—', gsc?.ok ? gi : '—'];
      }),
    ),
    '',
  );

  L.push(`## 記事別ランキング（自前PV 直近${WINDOW_DAYS}日 降順）`, '');
  L.push(
    mdTable(
      [
        '#',
        'KW',
        'slug',
        '公開日',
        '経過日',
        `直近${WINDOW_DAYS}日`,
        `前${WINDOW_DAYS}日`,
        '増減',
        '累計',
        '判定（自動）',
        'GA4 PV',
        '平均滞在(秒)',
        'GSCクリック',
        '表示',
        'CTR',
        '順位',
        '軸',
        'ファネル',
      ],
      perf.map((p, i) => {
        const gg = g(p.article.slug);
        const ss = s(p.article.slug);
        const ctr = ss && ss.impressions > 0 ? pct(ss.clicks / ss.impressions) : '—';
        return [
          i + 1,
          p.article.keyword,
          p.article.slug,
          p.pubYmd ?? '—',
          p.ageDays ?? '—',
          p.perf.pv,
          p.perf.prevPv,
          deltaText(p.perf.delta),
          p.perf.total,
          p.perf.flag || '—',
          gg ? gg.pv : '—',
          gg && gg.users > 0 ? Math.round(gg.engSec / gg.users) : '—',
          ss ? ss.clicks : '—',
          ss ? ss.impressions : '—',
          ctr,
          ss && ss.impressions > 0 ? ss.position.toFixed(1) : '—',
          axisShort(p.article.axis),
          p.article.funnel,
        ];
      }),
    ),
    '',
  );

  if (ga4?.ok && ga4.channels.size) {
    const chSet = new Set<string>();
    for (const m of ga4.channels.values()) for (const k of m.keys()) chSet.add(k);
    const chs = [...chSet].sort();
    const channels = ga4.channels;
    L.push(`## 記事別 流入チャネル（GA4 セッション・直近${WINDOW_DAYS}日）`, '');
    L.push(
      mdTable(
        ['KW', ...chs],
        perf
          .filter((p) => channels.has(p.article.slug))
          .map((p) => [p.article.keyword, ...chs.map((c) => channels.get(p.article.slug)!.get(c) ?? 0)]),
      ),
      '',
    );
  }

  L.push(`## 導線・CV（自前計測・直近${WINDOW_DAYS}日）`, '');
  L.push('### イベント別合計', '');
  L.push(mdTable(['イベント', '回数'], [...evByName.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => [n, c])), '');
  L.push('### CVの発火場所（label）', '');
  L.push(mdTable(['イベント @ 発火場所', '回数'], [...cvByLabel.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, c])), '');
  L.push('### 流入元別（utm_source。イベント総数とCV）', '');
  L.push(
    mdTable(
      ['流入元', 'イベント', 'CV'],
      [...evBySource.entries()].sort((a, b) => b[1].events - a[1].events).map(([src, v]) => [src, v.events, v.cv]),
    ),
    '',
  );

  if (gsc?.ok) {
    // クエリはページ横断で束ねる（同じ語で複数記事が出ているケースを見るため）。順位は表示加重
    type QAgg = GscQuery & { slugs: Set<string> };
    const byQuery = new Map<string, QAgg>();
    for (const q of gsc.queries) {
      const cur = byQuery.get(q.query) ?? { ...q, clicks: 0, impressions: 0, position: 0, slugs: new Set<string>() };
      const w = cur.impressions + q.impressions;
      cur.position = w > 0 ? (cur.position * cur.impressions + q.position * q.impressions) / w : 0;
      cur.clicks += q.clicks;
      cur.impressions += q.impressions;
      cur.slugs.add(q.slug);
      byQuery.set(q.query, cur);
    }
    const qs = [...byQuery.values()];
    const qRow = (q: QAgg): Array<string | number> => [
      q.query,
      q.clicks,
      q.impressions,
      q.impressions > 0 ? pct(q.clicks / q.impressions) : '—',
      q.position.toFixed(1),
      [...q.slugs].join(' / '),
    ];
    const qHead = ['クエリ', 'クリック', '表示', 'CTR', '順位', '記事'];

    L.push(`## GSC クエリ（/media/ 配下・${gsc.range.start}〜${gsc.range.end}）`, '');
    L.push('### クリック上位（20）', '');
    L.push(
      mdTable(
        qHead,
        qs
          .filter((q) => q.clicks > 0)
          .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
          .slice(0, 20)
          .map(qRow),
      ),
      '',
    );
    L.push('### 表示上位（20・クリックの有無を問わず）', '');
    L.push(mdTable(qHead, [...qs].sort((a, b) => b.impressions - a.impressions).slice(0, 20).map(qRow)), '');
    L.push(
      `### 取りこぼし（表示≥${GSC_MISS_MIN_IMPR}・CTR<${GSC_MISS_MAX_CTR * 100}%＝順位はあるのに押されていない。タイトル／ディスクリプションの見直し候補）`,
      '',
    );
    L.push(
      mdTable(
        qHead,
        qs
          .filter((q) => q.impressions >= GSC_MISS_MIN_IMPR && q.clicks / q.impressions < GSC_MISS_MAX_CTR)
          .sort((a, b) => b.impressions - a.impressions)
          .map(qRow),
      ),
      '',
    );
    L.push(
      `### striking distance（順位${STRIKE_POS_MIN}〜${STRIKE_POS_MAX}・表示≥${STRIKE_MIN_IMPR}＝あと一押しで1ページ目上位。加筆・内部リンクの候補）`,
      '',
    );
    L.push(
      mdTable(
        qHead,
        qs
          .filter((q) => q.impressions >= STRIKE_MIN_IMPR && q.position >= STRIKE_POS_MIN && q.position <= STRIKE_POS_MAX)
          .sort((a, b) => b.impressions - a.impressions)
          .map(qRow),
      ),
      '',
    );
    L.push(`### 記事別 上位クエリ（各${QUERIES_PER_PAGE}件・表示順）`, '');
    const perPage: Array<Array<string | number>> = [];
    for (const p of perf) {
      const mine = gsc.queries
        .filter((q) => q.slug === p.article.slug)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, QUERIES_PER_PAGE);
      for (const q of mine) perPage.push([p.article.keyword, q.query, q.clicks, q.impressions, q.position.toFixed(1)]);
    }
    L.push(mdTable(['記事（KW）', 'クエリ', 'クリック', '表示', '順位'], perPage), '');
    L.push('- しきい値は立ち上げ期の暫定（`scripts/update-pv.ts` 冒頭の定数）。表示が3桁に乗ったら上げる', '');
  } else {
    // 取れていない回も見出しは出す。レポートを書く側が「無い」と「見落とし」を区別できるように
    L.push('## GSC クエリ', '');
  }
  // カニバリ（実測）／未カバーのクエリ／リライト優先度。GSC が無い回は「出せない」の1行になる
  L.push(
    ...buildGscExtraSections(
      gsc,
      perf.map((p) => ({
        slug: p.article.slug,
        keyword: p.article.keyword,
        pubYmd: p.pubYmd,
        updYmd: isoToYmd(p.article.updated_at),
      })),
      keywordsR,
      today,
    ),
  );

  L.push('## 前回比（PV履歴.csv の直近2断面・機械計算）', '');
  if (prevDate) {
    const prevTot = [...prevBySlug.values()].reduce((n, h) => n + h.pv, 0);
    L.push(`- 基準: ${prevDate} → ${today}`);
    L.push(`- 自前PV（直近${WINDOW_DAYS}日の断面）: ${fmt(prevTot)} → ${fmt(pvCur)}（${deltaText(deltaPct(pvCur, prevTot))}）`);
    const moves = perf.map((p) => {
      const h = prevBySlug.get(p.article.slug);
      return { kw: p.article.keyword, cur: p.perf.pv, prev: h ? h.pv : null, isNew: !h };
    });
    const risers = moves
      .filter((m) => m.prev !== null && m.cur > m.prev)
      .sort((a, b) => b.cur - b.prev! - (a.cur - a.prev!))
      .slice(0, 5);
    const fallers = moves
      .filter((m) => m.prev !== null && m.cur < m.prev)
      .sort((a, b) => a.cur - a.prev! - (b.cur - b.prev!))
      .slice(0, 5);
    L.push(`- 伸び: ${risers.map((m) => `${m.kw}（${m.prev}→${m.cur}）`).join('、') || '—'}`);
    L.push(`- 落ち: ${fallers.map((m) => `${m.kw}（${m.prev}→${m.cur}）`).join('、') || '—'}`);
    L.push(`- 新規（前回の断面に無い）: ${moves.filter((m) => m.isNew).map((m) => `${m.kw}（${m.cur}）`).join('、') || '—'}`);
    if (gsc?.ok) {
      const gscMoves = perf
        .map((p) => {
          const h = prevBySlug.get(p.article.slug);
          const ss = s(p.article.slug);
          if (!h || !ss || !h.gscImpr || !h.gscPos || ss.impressions === 0) return null;
          return { kw: p.article.keyword, prevPos: h.gscPos, curPos: ss.position, prevImpr: h.gscImpr, curImpr: ss.impressions };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      if (gscMoves.length) {
        L.push(
          `- GSC 順位の動き（前回→今回、表示）: ${gscMoves
            .sort((a, b) => a.curPos - a.prevPos - (b.curPos - b.prevPos))
            .map((m) => `${m.kw} ${m.prevPos.toFixed(1)}→${m.curPos.toFixed(1)}（表示 ${m.prevImpr}→${m.curImpr}）`)
            .join('、')}`,
        );
      }
    }
  } else {
    L.push('- 履歴が今回の1断面だけなので前回比なし（次回から出る）。');
  }
  L.push('');

  L.push('## 台帳（KWマスターDB.csv）', '');
  L.push(`- D1 の全記事 ${articles.length} 行で再生成${opts.dryRun ? 'する予定（dry-run）' : 'した'}。列は \`/api/export.csv\` と同じ（src/lib/kw-csv.ts）`);
  L.push(`- 更新前の台帳に載っていなかった公開記事: ${missingInCsv.length ? missingInCsv.join(', ') : '無し'}`);
  L.push(
    `- KW台帳（D1 keywords）: ${keywordsR.length} 件（dropped 除く ${keywordsLive} 件）。「未カバーのクエリ」は、この台帳と公開記事の keyword のどれとも重ならない語を GSC から拾ったもの`,
  );
  L.push('');

  const factsheet = L.join('\n');

  /* ── GSC クエリのファイル（取れた回だけ）── */
  // 取れなかった回は前回のファイルに触らない。snapshot 側は ymd を見て別の日の分を弾く（readSnapshotQueries）。
  // KW候補側は日付を持たない配列（volume.ts の契約）なので古いまま残る。「無いより前回の分」の判断
  const snapshotQueries = gsc?.ok ? buildSnapshotQueries(gsc.queries) : [];
  const allQueries = gsc?.ok
    ? aggregateByQuery(gsc.queries)
        .slice(0, GSC_ALL_QUERIES_LIMIT)
        .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: round1(q.position) }))
    : [];

  /* ── 書き出し ── */
  section('書き出し');
  if (opts.dryRun) {
    console.log('  dry-run のため何も書かない。書く予定だったもの:');
    console.log(`    ${CSV_PATH}（${articles.length} 行）`);
    console.log(`    ${HISTORY_PATH}（${today} の ${todayRows.length} 行を追記／同日分は差し替え）`);
    console.log(`    ${FACTSHEET_PATH}`);
    if (gsc?.ok) {
      console.log(`    ${GSC_QUERIES_SNAPSHOT_PATH}（${snapshotQueries.length} 行・snapshot 用に間引き）`);
      console.log(`    ${GSC_QUERIES_ALL_PATH}（${allQueries.length} クエリ・KW選定用の全量）`);
    } else {
      console.log('    （GSC が無いので gsc-queries.json は書かない）');
    }
    return;
  }

  writeFileSync(
    CSV_PATH,
    buildKwCsv(
      articles.map((a) => ({
        article: a,
        perf: perf.find((p) => p.article.id === a.id)?.perf ?? null,
      })),
    ),
    'utf8',
  );

  // 既存行は列をそのまま残し（列が増えても壊さない）、今日の分だけ差し替える
  const keptRaw = existsSync(HISTORY_PATH)
    ? parseCsv(readFileSync(HISTORY_PATH, 'utf8'))
        .slice(1)
        .filter((r) => r[0] !== today)
    : [];
  const histLines = [csvRow(HISTORY_HEADER), ...keptRaw.map((r) => csvRow(r)), ...todayRows.map((r) => csvRow(r))];
  writeFileSync(HISTORY_PATH, '﻿' + histLines.join('\r\n') + '\r\n', 'utf8');

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(FACTSHEET_PATH, factsheet + '\n', 'utf8');

  console.log(`  ${CSV_PATH}`);
  console.log(`  ${HISTORY_PATH}`);
  console.log(`  ${FACTSHEET_PATH}`);

  if (gsc?.ok) {
    // 1行1レコードにしておくと git の差分がクエリ単位で読める
    const jsonLines = (rows: unknown[]) => `[\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
    writeFileSync(
      GSC_QUERIES_SNAPSHOT_PATH,
      `{\n  "ymd": ${JSON.stringify(today)},\n  "range": ${JSON.stringify(gsc.range)},\n  "rows": ${jsonLines(snapshotQueries).trimEnd()}\n}\n`,
      'utf8',
    );
    mkdirSync(KW_CANDIDATE_DIR, { recursive: true });
    writeFileSync(GSC_QUERIES_ALL_PATH, jsonLines(allQueries), 'utf8');
    console.log(`  ${GSC_QUERIES_SNAPSHOT_PATH}（${snapshotQueries.length} 行）`);
    console.log(`  ${GSC_QUERIES_ALL_PATH}（${allQueries.length} クエリ）`);
  }

  console.log(`\n次: 現状ファクトシート.md だけを読んで 記事管理/PVレポート/週次レポート_${today}.md を書き、`);
  console.log(`    node --experimental-strip-types scripts/update-pv.ts --publish "記事管理/PVレポート/週次レポート_${today}.md"`);
  console.log('    で D1 に入れる（/admin/stats に出る。前回のレポートは開かない）。');
}

/*
 * 直接実行のときだけ main を回す。`node -e "import('.../update-pv.ts')"` で純粋関数だけ取り出せるように
 * （argv[1] が無い＝-e、別ファイルから import＝argv[1] がそのファイル）。Windows はドライブ文字の大小が揺れるので寄せて比べる。
 */
const selfPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isDirectRun = process.platform === 'win32' ? entryPath.toLowerCase() === selfPath.toLowerCase() : entryPath === selfPath;
if (isDirectRun) main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
