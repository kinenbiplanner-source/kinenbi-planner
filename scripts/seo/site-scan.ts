/**
 * 競合サイトの記事を観測する。何を書き足し（新着）、何を直している（更新）かを D1 に積み、レポートを出す。
 * `記事管理/競合/targets.json` の `sites` が対象。IG 側は ig-scan.ts。
 *
 * **伸びているかは Ahrefs が無いと分からない。ここで分かるのは、何を書き足しているか（新着）と何を直しているか（更新）。**
 * sitemap にも HTML にも流入の数字は無い。Ahrefs で取れた回だけ `--ahrefs` の JSON から traffic 列に入る。
 *
 *   node --experimental-strip-types scripts/seo/site-scan.ts                                   # 本番 D1。targets.json の全サイト
 *   node --experimental-strip-types scripts/seo/site-scan.ts --local --dry-run --site anny.gift --max 10
 *   node --experimental-strip-types scripts/seo/site-scan.ts --report-only                     # 取得せず D1 からレポートだけ
 *   node --experimental-strip-types scripts/seo/site-scan.ts --report-only --ahrefs 記事管理/競合/ahrefs.json
 *
 * オプション：
 *   --site <host>     1サイトだけ（targets.json の host）
 *   --max <n>         1回に取り込む新規記事の上限（既定 60）。既知の URL の更新には効かない
 *   --days <n>        「新着」「更新」とみなす日数（既定 30）
 *   --ahrefs <json>   {"<url>": {"traffic": 1200, "top_keyword": "…"}} を traffic / top_keyword に入れ、traffic_at に今日
 *   --report-only     取得せず D1 からレポートだけ（--ahrefs との併用可）
 *   --dry-run         取得して表示するだけ。D1 にもレポートファイルにも書かない
 *   --local           ローカル D1（既定は本番）
 *
 * 流れ：
 *   1. targets.json の sites を competitor_sites に upsert（host が鍵。label/adapter/entry/active/note は JSON が勝つ）
 *   2. adapter ごとに記事 URL を集める（wp-rest / sitemap / html。下の scan* を見る）。**新規 URL だけ**記事ページを取る
 *   3. competitor_pages に upsert（first_seen は初回だけ、last_seen は毎回、title/published_at/modified_at は取れたら上書き）
 *   4. レポート（標準出力＋ 記事管理/競合/記事観測_<日付>.md）。「自社との重なり」は台帳・記事の KW とのトークン重なり
 *
 * 相手への配慮：UA は名乗る。リクエスト間 1 秒、タイムアウト 15 秒、robots.txt の Disallow に当たる URL は取らない。
 * 失敗は URL ごとに 1 行出して続行する（1本落ちても全体を止めない）。
 *
 * 「新着」「更新」の決め方（レポート）：
 *   新着 … first_seen が --days 以内で、公開日が分かるならそれも --days 以内（公開日が無いページは更新日で代用）。
 *          初回の取り込みでも、古い公開日・更新日のものは新着に混ざらない
 *   更新 … 新着でなく、modified_at が --days 以内
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { normalizeKeyword, overlap, textHasToken, tokenize } from '../../src/lib/seo/tokens.ts';
import type { CompetitorPage, CompetitorSite, CompetitorTargets } from '../../src/lib/seo/types.ts';
import { ROOT, d1Many, die, lit, loadSeoCatalog, takeCommonFlag } from './_d1.ts';
import { jstToday } from './_env.ts';

/* ────────────────────────────────────────────────
 * 設定
 * ──────────────────────────────────────────────── */

/** 環境変数 SITE_SCAN_TARGETS で差し替えられる（アダプタの動作確認用。運用では使わない） */
const TARGETS_PATH = process.env.SITE_SCAN_TARGETS ? resolve(process.env.SITE_SCAN_TARGETS) : join(ROOT, '記事管理', '競合', 'targets.json');
const REPORT_DIR = join(ROOT, '記事管理', '競合');
const UA = 'Mozilla/5.0 (compatible; AnnivMediaBot/1.0; +https://anniv.gift)';
const WAIT_MS = 1000;
const TIMEOUT_MS = 15_000;
/** html アダプタ：一覧を何ページまで辿るか（entry ＋ ページ送り 2 つ） */
const LISTING_PAGES = 3;
/** wp-rest アダプタ：何ページまで取るか */
const REST_PAGES = 3;
const REST_PER_PAGE = 100;
/** sitemap アダプタ：index のときに辿る子 sitemap の上限 */
const SITEMAP_CHILDREN = 20;
/** 「自社との重なり」の Jaccard。これ未満は「空き」 */
const OVERLAP_MIN = 0.34;
const TRAFFIC_TOP = 20;
/** レポートの各表に出す行の上限（超えた分は件数だけ） */
const ROW_CAP = 150;
/** last_seen だけ更新する行は IN (…) にまとめる。1文あたりの URL 数 */
const TOUCH_CHUNK = 300;

/* ────────────────────────────────────────────────
 * オプション
 * ──────────────────────────────────────────────── */

interface Options {
  site: string;
  max: number;
  days: number;
  ahrefs: string;
  reportOnly: boolean;
  dryRun: boolean;
  local: boolean;
}

function parseArgs(argv: string[]): Options {
  const local = takeCommonFlag(argv, '--local');
  const dryRun = takeCommonFlag(argv, '--dry-run');
  const reportOnly = takeCommonFlag(argv, '--report-only');
  const o: Options = { site: '', max: 60, days: 30, ahrefs: '', reportOnly, dryRun, local };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--site') o.site = (argv[++i] ?? '').trim().toLowerCase();
    else if (a === '--max' || a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) die(`${a} は正の整数`);
      if (a === '--max') o.max = n;
      else o.days = n;
    } else if (a === '--ahrefs') o.ahrefs = resolve((argv[++i] ?? '').trim());
    else die(`知らないオプション: ${a}`);
  }
  if (o.ahrefs && !existsSync(o.ahrefs)) die(`--ahrefs のファイルが無い: ${o.ahrefs}`);
  return o;
}

/* ────────────────────────────────────────────────
 * 小物
 * ──────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 突合用のキー。プロトコル・大文字小文字・末尾スラッシュ・クエリ・ハッシュの違いを吸う（--ahrefs の URL と D1 の URL を寄せる） */
function urlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  }
}

/** 日付らしい文字列 → YYYY-MM-DD。時刻・タイムゾーンは落とす（表示と日数比較にしか使わない） */
function ymd(s: unknown): string {
  if (typeof s !== 'string' || !s) return '';
  const m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : '';
}

function daysAgo(today: string, days: number): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', yen: '¥', middot: '·',
  laquo: '«', raquo: '»', times: '×', bull: '•',
};

/** HTML エンティティを戻す（WP REST の title.rendered は `&#8211;` `&amp;` を含む） */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
    if (body.startsWith('#')) {
      const cp = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** タグを剥がしてテキストだけにする。行の区切りは残す（一覧カードの「タイトル／カテゴリ／日付」を行で拾うため） */
function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>|<\/(?:div|p|li|h[1-6]|span)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** タグ1個の属性を読む（属性の順番に依存しないため。og:title は content が先に来るサイトもある） */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function metaContent(html: string, key: 'property' | 'name', value: string): string {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a[key] ?? '').toLowerCase() === value) return (a.content ?? '').trim();
  }
  return '';
}

/* ────────────────────────────────────────────────
 * 取得（UA・間隔・タイムアウト・robots）
 * ──────────────────────────────────────────────── */

interface Fetched {
  ok: boolean;
  status: number;
  text: string;
}

let lastFetchAt = 0;

/** robots を見ずに取る（robots.txt 自身を取るため）。間隔と失敗ログはここで持つ */
async function rawFetch(url: string): Promise<Fetched> {
  const wait = WAIT_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let bytes = new Uint8Array(await res.arrayBuffer());
    // .xml.gz のような gzip ファイル（Content-Encoding ではなく中身が gzip）。マジックナンバーで見る
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        bytes = new Uint8Array(gunzipSync(bytes));
      } catch {
        /* gzip でなければそのまま */
      }
    }
    const ct = res.headers.get('content-type') ?? '';
    const charset = ct.match(/charset=([\w-]+)/i)?.[1] ?? '';
    let text = '';
    try {
      text = new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    if (!charset) {
      const mc = text.slice(0, 4096).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
      if (mc && !/^utf-?8$/i.test(mc)) {
        try {
          text = new TextDecoder(mc).decode(bytes);
        } catch {
          /* 知らない文字コードは utf-8 のまま */
        }
      }
    }
    if (!res.ok) console.log(`    [取得失敗] ${url}: HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    console.log(`    [取得失敗] ${url}: ${(e as Error).message}`);
    return { ok: false, status: 0, text: '' };
  }
}

const robotsCache = new Map<string, RegExp[]>();

/**
 * robots.txt の Disallow（User-agent: * と AnnivMediaBot の両方。合わせて守る）。
 * `*` はワイルドカード、末尾 `$` は終端。取れなければ制限なし扱い。
 */
async function robotsRules(host: string): Promise<RegExp[]> {
  const hit = robotsCache.get(host);
  if (hit) return hit;
  const rules: RegExp[] = [];
  const res = await rawFetch(`https://${host}/robots.txt`);
  if (res.ok) {
    let applies = false;
    let sawRule = false;
    for (const raw of res.text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const k = m[1]!.toLowerCase();
      const v = m[2]!.trim();
      if (k === 'user-agent') {
        if (sawRule) {
          applies = false;
          sawRule = false;
        }
        if (v === '*' || v.toLowerCase().includes('annivmediabot')) applies = true;
      } else if (k === 'disallow' || k === 'allow') {
        sawRule = true;
        if (k === 'disallow' && applies && v) {
          const re = v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
          rules.push(new RegExp('^' + re));
        }
      }
    }
  }
  robotsCache.set(host, rules);
  return rules;
}

async function disallowed(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const rules = await robotsRules(u.host);
  const target = u.pathname + u.search;
  return rules.some((re) => re.test(target));
}

async function politeFetch(url: string): Promise<Fetched> {
  if (await disallowed(url)) {
    console.log(`    [robots] Disallow に当たるので取らない: ${url}`);
    return { ok: false, status: 0, text: '' };
  }
  return rawFetch(url);
}

/* ────────────────────────────────────────────────
 * 記事 URL の判定（html / sitemap 共通）
 * ──────────────────────────────────────────────── */

/**
 * anny.gift の実物（2026-09-10）で決めた規則：
 *   - 記事は `https://anny.gift/<数字>/`。新着一覧 /latest/ のカード（<a class="ArticleList_Item" href="/11279/">）も、
 *     robots.txt の sitemap（sitemap.xml.gz → S3 → sitemap1.xml.gz）に載る 9,129 本も全部この形
 *   - 商品は `/products/<数字>/`（sitemap に 14,535 本）、店舗は `/stores/…`
 *   - カテゴリ・特集は `/scene-<名前>/`（36 本）・`/l-genre-<名前>/`・`/special-<名前>/`・`/f_<数字>/`、一覧は `/latest/`・`/popular/`・`/new/`・`/recommend/`
 *   - ページ送りは `/latest/page_<N>/`（`/latest/?page=<N>` も同じ中身）
 *   → 「数字だけの 1 段パス」に絞ればこれらは全部落ちる。giftpedia も `/<数字>` なので同じ規則で通る。
 * 他のサイトを html / sitemap で足すときはここに形を足す（WP の `/YYYY/MM/slug/` と `/column/slug/` 型は先に入れてある）。
 */
const ARTICLE_PATHS: readonly RegExp[] = [
  /^\/\d+\/?$/,
  /^\/\d{4}\/\d{2}\/[^/?#]+\/?$/,
  /^\/(?:articles?|posts?|columns?|magazine|blog|media|entry|news)\/[^/?#]+\/?$/,
];
const NOT_ARTICLE_PATH = /^\/(?:(?:products?|stores?|latest|popular|new|recommend|history|genres|tag|category|page)(?:[/?#]|$)|(?:scene|l-genre|special)-|f_\d)/i;

/** 記事の URL なら正規化した絶対 URL（クエリ・ハッシュ無し）。違えば null */
function articleUrl(host: string, href: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const strip = (h: string) => h.replace(/^www\./, '').toLowerCase();
  if (strip(u.hostname) !== strip(host)) return null;
  if (NOT_ARTICLE_PATH.test(u.pathname)) return null;
  if (!ARTICLE_PATHS.some((re) => re.test(u.pathname))) return null;
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/* ────────────────────────────────────────────────
 * 記事ページ・一覧ページの読み取り
 * ──────────────────────────────────────────────── */

/** アダプタが返す 1 記事。空文字は「取れなかった」＝upsert で既存値を残す */
interface Found {
  url: string;
  title: string;
  published_at: string;
  modified_at: string;
}

interface PageMeta {
  title: string;
  published: string;
  modified: string;
}

/**
 * ld+json の datePublished / dateModified。anny の記事は `article:published_time` を出さず、
 * NewsArticle の ld+json だけに日付がある（新しい記事は datePublished が null で dateModified だけ入る）。
 */
function ldDates(html: string): { published: string; modified: string } {
  let published = '';
  let modified = '';
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (!published && typeof o.datePublished === 'string') published = o.datePublished;
    if (!modified && typeof o.dateModified === 'string') modified = o.dateModified;
    for (const k of ['@graph', 'mainEntity', 'itemListElement']) visit(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]!.trim()), 0);
    } catch {
      /* 壊れた JSON は無視 */
    }
  }
  return { published, modified };
}

/** 記事ページ 1 枚から title と日付。優先順は og:title → <title>（末尾のサイト名を落とす）、meta → ld+json → <time datetime> */
function pageMeta(html: string): PageMeta {
  const og = metaContent(html, 'property', 'og:title');
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = t ? textOf(t[1]!).replace(/\s+/g, ' ') : '';
  // 「… | Anny（アニー）」のようなサイト名は最後の区切りだけ落とす（anny のタイトルは途中に「｜」を使うので、区切りは空白付きに限る）
  const title = og || rawTitle.replace(/\s+[|｜-]\s+[^|｜-]*$/, '').trim() || rawTitle;
  const ld = ldDates(html);
  const time = html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1] ?? '';
  const published = ymd(metaContent(html, 'property', 'article:published_time') || ld.published || time);
  const modified = ymd(metaContent(html, 'property', 'article:modified_time') || ld.modified);
  return { title: title.replace(/\s+/g, ' ').trim(), published, modified };
}

/**
 * 一覧 HTML から記事カードを拾う。
 * anny の /latest/ は <a class="ArticleList_Item" href="/11279/"> の中に <div class='ArticleList_Title'>、
 * カテゴリ、「2026/09/10更新」が入る。他サイトも「アンカーの中にタイトルと日付」が普通なので、
 *   タイトル … class に title を含む要素 → img の alt → アンカー内テキストで一番長い行
 *   日付     … 「更新」が付けば modified、「公開」か無印なら published
 * の順で取る。同じ記事が画像とテキストで 2 つのアンカーに分かれているときは寄せる。
 */
function listingCards(host: string, pageUrl: string, html: string): Found[] {
  const out = new Map<string, Found>();
  const pageKey = urlKey(pageUrl);
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrs(m[1]!).href;
    if (!href) continue;
    const url = articleUrl(host, href, pageUrl);
    if (!url || urlKey(url) === pageKey) continue;
    const inner = m[2]!;
    let title = '';
    const t = inner.match(/<[a-z][^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\//i);
    if (t) title = textOf(t[1]!).replace(/\s+/g, ' ').trim();
    if (!title) {
      const img = inner.match(/<img\b[^>]*>/i);
      if (img) title = (attrs(img[0]).alt ?? '').trim();
    }
    if (!title) {
      title =
        textOf(inner)
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s && !/^\d{4}[/.\-年]\d{1,2}/.test(s))
          .sort((a, b) => b.length - a.length)[0] ?? '';
    }
    let published = '';
    let modified = '';
    for (const d of textOf(inner).matchAll(/(\d{4}[/.\-年]\d{1,2}[/.\-月]\d{1,2})日?\s*(更新|公開)?/g)) {
      if (d[2] === '更新') modified ||= ymd(d[1]);
      else published ||= ymd(d[1]);
    }
    const prev = out.get(url);
    out.set(url, {
      url,
      title: title || prev?.title || '',
      published_at: published || prev?.published_at || '',
      modified_at: modified || prev?.modified_at || '',
    });
  }
  return [...out.values()];
}

/**
 * ページ送り。anny は `/latest/page_2/` … `/latest/page_914/`（`/latest/?page=2` も同じ中身）。
 * 一覧のパスの下に page_N / page-N / page/N が付くか、?page=N / ?paged=N のどれかだけをページ送りとみなし、
 * N の小さい順に LISTING_PAGES-1 個（entry と合わせて 3 ページ）。
 */
function paginationLinks(listingUrl: string, html: string): string[] {
  const base = new URL(listingUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const found = new Map<number, string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]!), listingUrl);
    } catch {
      continue;
    }
    if (u.host !== base.host) continue;
    const rest = u.pathname.replace(/\/+$/, '');
    const q = u.searchParams.get('page') ?? u.searchParams.get('paged');
    let n = 0;
    if (q && rest === basePath) n = Number(q);
    else if (rest.startsWith(`${basePath}/`)) {
      const pm = rest.slice(basePath.length + 1).match(/^page(?:[_-]?|\/)(\d+)$/i);
      if (pm) n = Number(pm[1]);
    }
    if (Number.isInteger(n) && n >= 2 && !found.has(n)) found.set(n, u.href);
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, LISTING_PAGES - 1)
    .map(([, href]) => href);
}

/* ────────────────────────────────────────────────
 * アダプタ
 * ──────────────────────────────────────────────── */

type SiteDef = CompetitorTargets['sites'][number] & { id: number; active: boolean };

/** アダプタに渡す共通の文脈 */
interface ScanCtx {
  /** そのサイトで D1 に既にある URL（urlKey） */
  known: Set<string>;
  /** 新規として取り込む上限（--max） */
  max: number;
  /** これより古い日付は「活動」ではなく在庫（--days） */
  cutoff: string;
  /** そのサイトの初回（D1 に 1 行も無い）。cutoff で切らずに観測の土台を作る */
  seedRun: boolean;
}

/**
 * 新規（D1 に無い URL）の絞り込み。全アダプタ共通。
 *   - 初回以外は、日付（更新日→公開日）が cutoff より古い未知 URL は取り込まない。昔からある記事の在庫であって
 *     今の活動ではない（giftpedia の 4,000 本を毎回 --max ずつ食べても意味がない）。日付が分からないものは取り込む
 *   - 残りを新しい順に並べ、--max まで。溢れた分は捨てる（次回また一覧に出ていれば拾う）
 *   - 既知の URL は全部返す（last_seen と更新日を写すため）
 * pick が記事ページを取る対象、rest が呼び出し側に返すもの（既知＋pick。同じオブジェクトなので pick への書き込みは rest にも効く）。
 */
function pickFresh(found: Found[], ctx: ScanCtx): { pick: Found[]; rest: Found[]; unknown: number } {
  const dateOf = (f: Found) => f.modified_at || f.published_at;
  const unknown = found.filter((f) => !ctx.known.has(urlKey(f.url)));
  const pick = unknown
    .filter((f) => ctx.seedRun || !dateOf(f) || dateOf(f) >= ctx.cutoff)
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
    .slice(0, ctx.max);
  const keep = new Set(pick.map((f) => f.url));
  return { pick, rest: found.filter((f) => ctx.known.has(urlKey(f.url)) || keep.has(f.url)), unknown: unknown.length };
}

function logPick(total: number, r: { pick: Found[]; unknown: number }, ctx: ScanCtx): void {
  const skipped = r.unknown - r.pick.length;
  const why = ctx.seedRun ? '--max 超え' : `${ctx.cutoff} より古いか --max 超え`;
  console.log(`  記事 ${total}（既知 ${total - r.unknown}・新規 ${r.pick.length}${skipped > 0 ? `。未知の ${skipped} 件は${why}で取り込まない` : ''}）`);
}

/**
 * wp-rest：`entry?per_page=100&orderby=modified&_fields=…&page=N`。modified 降順なので、
 * --days より古い modified が出たページで止める（or 3 ページ）。ページを超えると 400 が返るのでそこでも止まる。
 * **そのサイトの初回（D1 に 1 行も無い）は cutoff で止めず 3 ページ取る**——最終更新が古いサイト（giftpedia は 2024-05）でも
 * 観測の土台を作るため。以降の回は --days 内の更新だけ見ればいい。
 * giftpedia は orderby=modified を付けると 1 ページ目だけ 2 件しか返らないことがある（X-WP-TotalPages も 2 件換算）。
 * 2 ページ目以降は 100 件返るので、件数が少ないことを理由には止めない。
 */
async function scanWpRest(site: SiteDef, ctx: ScanCtx): Promise<Found[]> {
  const out: Found[] = [];
  for (let page = 1; page <= REST_PAGES; page++) {
    const u = new URL(site.entry);
    u.searchParams.set('per_page', String(REST_PER_PAGE));
    u.searchParams.set('orderby', 'modified');
    u.searchParams.set('_fields', 'id,link,title,date,modified');
    u.searchParams.set('page', String(page));
    const r = await politeFetch(u.href);
    if (!r.ok) break;
    let items: unknown;
    try {
      items = JSON.parse(r.text);
    } catch {
      console.log(`    [取得失敗] ${u.href}: JSON として読めない`);
      break;
    }
    if (!Array.isArray(items) || items.length === 0) break;
    let stale = false;
    for (const it of items as Array<Record<string, unknown>>) {
      const link = typeof it.link === 'string' ? it.link.trim() : '';
      if (!link) continue;
      const rendered = (it.title as Record<string, unknown> | undefined)?.rendered;
      const modified = ymd(it.modified);
      out.push({
        url: link,
        title: textOf(typeof rendered === 'string' ? rendered : '').replace(/\s+/g, ' '),
        published_at: ymd(it.date),
        modified_at: modified,
      });
      if (modified && modified < ctx.cutoff) stale = true;
    }
    console.log(`  REST page ${page}: ${items.length} 件`);
    if (stale && !ctx.seedRun) break;
  }
  const r = pickFresh(out, ctx);
  logPick(out.length, r, ctx);
  return r.rest;
}

/**
 * sitemap：entry を取り、index なら子を辿る（上限 SITEMAP_CHILDREN）。loc / lastmod を読み、記事 URL だけ残す。
 * 既知の URL は lastmod を modified_at に写すだけ。**新規 URL だけ**ページを取って title と公開日（lastmod の新しい順に --max まで）。
 * anny の sitemap は robots.txt の `sitemap.xml.gz` → S3 へ 301 → index → `sitemap1.xml.gz`（3.6MB、記事 9,129 本＋商品 14,535 本）。
 * gzip は rawFetch が剥がす。
 */
async function scanSitemap(site: SiteDef, ctx: ScanCtx): Promise<Found[]> {
  const parse = (xml: string) =>
    [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => ({
      loc: decodeEntities(m[1]!.match(/<loc>([^<]*)<\/loc>/i)?.[1] ?? '').trim(),
      lastmod: ymd(m[1]!.match(/<lastmod>([^<]*)<\/lastmod>/i)?.[1]),
    }));
  const root = await politeFetch(site.entry);
  if (!root.ok) return [];
  const entries: Array<{ loc: string; lastmod: string }> = [];
  if (/<sitemapindex/i.test(root.text)) {
    const children = [...root.text.matchAll(/<sitemap>[\s\S]*?<loc>([^<]*)<\/loc>/gi)]
      .map((m) => decodeEntities(m[1]!).trim())
      .filter(Boolean)
      .slice(0, SITEMAP_CHILDREN);
    console.log(`  sitemap index → 子 ${children.length} 本`);
    for (const c of children) {
      const r = await politeFetch(c);
      if (r.ok) entries.push(...parse(r.text));
    }
  } else entries.push(...parse(root.text));
  const all = new Map<string, Found>();
  for (const e of entries) {
    const url = articleUrl(site.host, e.loc, site.entry);
    if (!url) continue;
    const prev = all.get(url);
    all.set(url, { url, title: '', published_at: '', modified_at: e.lastmod || prev?.modified_at || '' });
  }
  console.log(`  sitemap URL ${entries.length} → 記事 URL ${all.size}`);
  const r = pickFresh([...all.values()], ctx);
  logPick(all.size, r, ctx);
  for (const f of r.pick) {
    const page = await politeFetch(f.url);
    if (!page.ok) continue;
    const meta = pageMeta(page.text);
    f.title = meta.title;
    f.published_at = meta.published;
    f.modified_at = meta.modified || f.modified_at;
  }
  return r.rest;
}

/**
 * entry に記事リンクが無いとき、一覧ページを探す。
 * anny の targets.json の entry は /magazine/ だが、そこは「Anny マガジン」アプリの LP（<title>サービスについて</title>）で記事リンクが 0 本。
 * 記事の一覧はトップの「新着記事一覧」リンク先 /latest/。entry → サイトのトップの順に
 * 「新着記事」「記事一覧」「新着」「一覧」を含むリンクを探し、記事カードが拾えたものを一覧として使う。
 */
async function discoverListing(site: SiteDef, entryHtml: string): Promise<{ url: string; html: string } | null> {
  const PRIORITY = [/新着記事/, /記事一覧/, /新着/, /一覧/];
  const pick = (pageUrl: string, html: string): string | null => {
    const pageHost = new URL(pageUrl).host;
    let best: { url: string; rank: number } | null = null;
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attrs(m[1]!).href;
      if (!href) continue;
      let u: URL;
      try {
        u = new URL(href, pageUrl);
      } catch {
        continue;
      }
      if (u.host !== pageHost) continue;
      const rank = PRIORITY.findIndex((re) => re.test(textOf(m[2]!)));
      if (rank < 0) continue;
      if (!best || rank < best.rank) best = { url: `${u.protocol}//${u.host}${u.pathname}`, rank };
    }
    return best?.url ?? null;
  };
  const candidates: Array<string | null> = [pick(site.entry, entryHtml)];
  if (!candidates[0]) {
    const top = `https://${site.host}/`;
    const r = await politeFetch(top);
    if (r.ok) candidates.push(pick(top, r.text));
  }
  for (const c of candidates) {
    if (!c || urlKey(c) === urlKey(site.entry)) continue;
    const r = await politeFetch(c);
    if (r.ok && listingCards(site.host, c, r.text).length > 0) return { url: c, html: r.text };
  }
  return null;
}

/**
 * html：entry の一覧 HTML から記事リンクを抽出（規則は articleUrl / listingCards / paginationLinks のコメント）。
 * ページ送りがあれば 3 ページまで。**新規 URL だけ**記事ページを取り、og:title と日付を読む（--max まで）。
 * 既知の URL は一覧に出ている「更新」日付を modified_at に写す（anny は記事ページより一覧の方が更新日を素直に出している）。
 */
async function scanHtml(site: SiteDef, ctx: ScanCtx): Promise<Found[]> {
  const entry = await politeFetch(site.entry);
  if (!entry.ok) return [];
  let listingUrl = site.entry;
  let listingHtml = entry.text;
  let cards = listingCards(site.host, listingUrl, listingHtml);
  if (cards.length === 0) {
    const alt = await discoverListing(site, listingHtml);
    if (!alt) {
      console.log(`  entry にも一覧らしいページにも記事リンクが無い（${site.entry}）`);
      return [];
    }
    console.log(`  entry に記事リンクが無いので一覧を探した → ${alt.url}（targets.json の entry をこれにすると 2 リクエスト減る）`);
    listingUrl = alt.url;
    listingHtml = alt.html;
    cards = listingCards(site.host, listingUrl, listingHtml);
  }
  const more = paginationLinks(listingUrl, listingHtml);
  for (const p of more) {
    const r = await politeFetch(p);
    if (r.ok) cards.push(...listingCards(site.host, p, r.text));
  }
  const byUrl = new Map<string, Found>();
  for (const c of cards) {
    const prev = byUrl.get(c.url);
    byUrl.set(
      c.url,
      prev
        ? { url: c.url, title: prev.title || c.title, published_at: prev.published_at || c.published_at, modified_at: prev.modified_at || c.modified_at }
        : c,
    );
  }
  const all = [...byUrl.values()];
  console.log(`  一覧 ${1 + more.length} ページ → 記事リンク ${all.length}`);
  const r = pickFresh(all, ctx);
  logPick(all.length, r, ctx);
  for (const c of r.pick) {
    const page = await politeFetch(c.url);
    if (!page.ok) continue;
    const meta = pageMeta(page.text);
    c.title = meta.title || c.title;
    c.published_at = meta.published || c.published_at;
    c.modified_at = meta.modified || c.modified_at;
  }
  return r.rest;
}

/* ────────────────────────────────────────────────
 * D1
 * ──────────────────────────────────────────────── */

/** first_seen は初回だけ（UPDATE に入れない）。空文字で来た列は既存値を残す。traffic 系はここでは触らない */
function upsertPageSql(p: CompetitorPage): string {
  return `INSERT INTO competitor_pages (url,site_id,title,published_at,modified_at,first_seen,last_seen,traffic,top_keyword,traffic_at)
  VALUES (${lit(p.url)},${p.site_id},${lit(p.title)},${lit(p.published_at)},${lit(p.modified_at)},${lit(p.first_seen)},${lit(p.last_seen)},NULL,'','')
  ON CONFLICT(url) DO UPDATE SET
    site_id=excluded.site_id,
    title=CASE WHEN excluded.title='' THEN competitor_pages.title ELSE excluded.title END,
    published_at=CASE WHEN excluded.published_at='' THEN competitor_pages.published_at ELSE excluded.published_at END,
    modified_at=CASE WHEN excluded.modified_at='' THEN competitor_pages.modified_at ELSE excluded.modified_at END,
    last_seen=excluded.last_seen`;
}

function upsertSiteSql(s: SiteDef, today: string): string {
  return `INSERT INTO competitor_sites (host,label,adapter,entry,active,fetched_at,note,created_at)
  VALUES (${lit(s.host)},${lit(s.label ?? '')},${lit(s.adapter)},${lit(s.entry)},${s.active ? 1 : 0},'',${lit(s.note ?? '')},${lit(today)})
  ON CONFLICT(host) DO UPDATE SET label=excluded.label, adapter=excluded.adapter, entry=excluded.entry, active=excluded.active, note=excluded.note`;
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2));
const today = jstToday();
const cutoff = daysAgo(today, opts.days);
const d1 = { local: opts.local };
/** --dry-run のときだけ D1 に書かない。--report-only は取得しないだけで、--ahrefs の書き込みはする */
const write = !opts.dryRun;

if (!existsSync(TARGETS_PATH)) die(`${TARGETS_PATH} が無い`);
const targets = JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as CompetitorTargets;
const siteDefs = (targets.sites ?? []).map((s) => ({ ...s, host: s.host.trim().toLowerCase(), active: s.active !== false }));
if (siteDefs.length === 0) die('targets.json の sites が空');
if (opts.site && !siteDefs.some((s) => s.host === opts.site)) {
  die(`--site ${opts.site} は targets.json に無い（${siteDefs.map((s) => s.host).join(' / ')}）`);
}

/* ── 1. targets → competitor_sites ── */
if (write && !opts.reportOnly) {
  d1Many(
    siteDefs.map((s) => upsertSiteSql({ ...s, id: 0 }, today)),
    d1,
  );
}
const [siteRows, pageRows] = d1Many(
  [
    `SELECT id, host, label, adapter, entry, active, fetched_at, note FROM competitor_sites ORDER BY id`,
    `SELECT url, site_id, title, published_at, modified_at, first_seen, last_seen, traffic, top_keyword, traffic_at FROM competitor_pages`,
  ],
  d1,
);
const sites: CompetitorSite[] = (siteRows as any[]).map((r) => ({
  id: Number(r.id),
  host: String(r.host ?? ''),
  label: String(r.label ?? ''),
  adapter: String(r.adapter ?? ''),
  entry: String(r.entry ?? ''),
  active: Number(r.active ?? 1),
  fetched_at: String(r.fetched_at ?? ''),
  note: String(r.note ?? ''),
}));
// --dry-run で D1 にまだ無いサイトは仮の id（負）で持つ。書かないので衝突しない
for (const s of siteDefs) {
  if (!sites.some((x) => x.host === s.host)) {
    sites.push({ id: -(sites.length + 1), host: s.host, label: s.label ?? '', adapter: s.adapter, entry: s.entry, active: s.active ? 1 : 0, fetched_at: '', note: s.note ?? '' });
  }
}
const siteById = new Map(sites.map((s) => [s.id, s]));
const siteIdOf = (host: string) => sites.find((s) => s.host === host)!.id;

/** urlKey → 行。既存＋今回の取得結果を全部ここに乗せ、D1 への書き込みもレポートもこれを見る */
const pages = new Map<string, CompetitorPage>();
for (const r of pageRows as any[]) {
  const row: CompetitorPage = {
    url: String(r.url ?? ''),
    site_id: Number(r.site_id),
    title: String(r.title ?? ''),
    published_at: String(r.published_at ?? ''),
    modified_at: String(r.modified_at ?? ''),
    first_seen: String(r.first_seen ?? ''),
    last_seen: String(r.last_seen ?? ''),
    traffic: r.traffic === null || r.traffic === undefined ? null : Number(r.traffic),
    top_keyword: String(r.top_keyword ?? ''),
    traffic_at: String(r.traffic_at ?? ''),
  };
  pages.set(urlKey(row.url), row);
}
console.log(
  `${opts.local ? 'ローカル' : '本番'} D1: サイト ${siteRows.length} 件・記事 ${pages.size} 件 ／ 今日 ${today}・${opts.days} 日以内（${cutoff} 以降）を新着・更新とみなす`,
);

/* ── 2. 取得 ── */
const scanSites: SiteDef[] = siteDefs
  .filter((s) => s.active && (!opts.site || s.host === opts.site))
  .map((s) => ({ ...s, id: siteIdOf(s.host) }));
const sqls: string[] = [];
const touched: string[] = [];

if (!opts.reportOnly) {
  for (const s of scanSites) {
    console.log(`\n${s.host}（${s.adapter}）: ${s.entry}`);
    const known = new Set([...pages.values()].filter((p) => p.site_id === s.id).map((p) => urlKey(p.url)));
    const ctx: ScanCtx = { known, max: opts.max, cutoff, seedRun: known.size === 0 };
    if (ctx.seedRun) console.log(`  初回（D1 に行が無い）。${opts.days} 日で切らずに土台を作る`);
    let found: Found[] = [];
    if (s.adapter === 'wp-rest') found = await scanWpRest(s, ctx);
    else if (s.adapter === 'sitemap') found = await scanSitemap(s, ctx);
    else if (s.adapter === 'html') found = await scanHtml(s, ctx);
    else {
      console.log(`  知らない adapter「${s.adapter}」。飛ばす（wp-rest / sitemap / html）`);
      continue;
    }
    // 新規の絞り込み（cutoff・--max）はアダプタ側の pickFresh で済んでいる。ここは D1 との差分を取るだけ
    let added = 0;
    let updated = 0;
    let same = 0;
    for (const f of found) {
      const key = urlKey(f.url);
      const row = pages.get(key);
      if (row) {
        const changed =
          (f.title !== '' && f.title !== row.title) ||
          (f.published_at !== '' && f.published_at !== row.published_at) ||
          (f.modified_at !== '' && f.modified_at !== row.modified_at);
        if (f.title) row.title = f.title;
        if (f.published_at) row.published_at = f.published_at;
        if (f.modified_at) row.modified_at = f.modified_at;
        row.last_seen = today;
        row.site_id = s.id;
        if (changed) {
          sqls.push(upsertPageSql(row));
          updated++;
        } else {
          touched.push(row.url);
          same++;
        }
      } else {
        const row: CompetitorPage = {
          url: f.url,
          site_id: s.id,
          title: f.title,
          published_at: f.published_at,
          modified_at: f.modified_at,
          first_seen: today,
          last_seen: today,
          traffic: null,
          top_keyword: '',
          traffic_at: '',
        };
        pages.set(key, row);
        sqls.push(upsertPageSql(row));
        added++;
      }
    }
    const siteRow = siteById.get(s.id);
    if (siteRow) siteRow.fetched_at = today;
    if (s.id > 0) sqls.push(`UPDATE competitor_sites SET fetched_at=${lit(today)} WHERE id=${s.id}`);
    console.log(`  → 新規 ${added}・更新 ${updated}・変化なし ${same}`);
  }
  for (let i = 0; i < touched.length; i += TOUCH_CHUNK) {
    sqls.push(`UPDATE competitor_pages SET last_seen=${lit(today)} WHERE url IN (${touched.slice(i, i + TOUCH_CHUNK).map((u) => lit(u)).join(',')})`);
  }
  if (write) {
    if (sqls.length) d1Many(sqls, d1);
    console.log(`\nD1 に書いた: ${sqls.length} 文（記事の upsert・last_seen・fetched_at）`);
  } else console.log('\n--dry-run: D1 には書かない');
}

/* ── 3. --ahrefs（url 一致で traffic 列） ── */
if (opts.ahrefs) {
  let raw: Record<string, { traffic?: unknown; top_keyword?: unknown }>;
  try {
    raw = JSON.parse(readFileSync(opts.ahrefs, 'utf8'));
  } catch (e) {
    die(`--ahrefs の JSON を読めない: ${(e as Error).message}`);
  }
  const updates: string[] = [];
  const miss: string[] = [];
  for (const [url, v] of Object.entries(raw)) {
    const row = pages.get(urlKey(url));
    if (!row) {
      miss.push(url);
      continue;
    }
    const n = Number(v?.traffic);
    row.traffic = Number.isFinite(n) ? Math.round(n) : null;
    row.top_keyword = typeof v?.top_keyword === 'string' ? v.top_keyword.trim() : '';
    row.traffic_at = today;
    updates.push(`UPDATE competitor_pages SET traffic=${lit(row.traffic)}, top_keyword=${lit(row.top_keyword)}, traffic_at=${lit(today)} WHERE url=${lit(row.url)}`);
  }
  if (write && updates.length) d1Many(updates, d1);
  console.log(
    `--ahrefs: ${updates.length} 件に traffic を入れた${write ? '' : '（--dry-run なので表示だけ）'}` +
      (miss.length ? `。D1 に無い URL ${miss.length} 件: ${miss.slice(0, 5).join(' ')}${miss.length > 5 ? ' …' : ''}` : ''),
  );
}

/* ── 4. 自社との重なり ── */
const catalog = loadSeoCatalog(d1);
const ours = new Map<string, { kw: string; tokens: string[] }>();
const addOurs = (kw: string) => {
  const n = normalizeKeyword(kw);
  if (n && !ours.has(n)) ours.set(n, { kw: kw.replace(/[\s　]+/g, ' ').trim(), tokens: tokenize(kw) });
};
for (const k of catalog.keywords) if (k.status !== 'dropped' && k.keyword.trim()) addOurs(k.keyword);
for (const a of catalog.articles) if (a.keyword.trim()) addOurs(a.keyword);
const vocab = [...new Set([...ours.values()].flatMap((t) => t.tokens))];
const vocabSet = new Set(vocab);

/**
 * 競合のタイトルは分かち書きされていないので、そのまま tokenize しても 1 トークンにしかならない。
 * 台帳・記事の KW に出てくる語（vocab）がタイトルに含まれるかを textHasToken（同義語込み）で見て、
 * それをタイトル側のトークンにしてから Jaccard を取る。「店」「例」のような短い同義語で拾いすぎることはあるが、
 * OVERLAP_MIN で切れる範囲。
 */
function overlapLabel(title: string): { label: string; free: boolean } {
  if (!title || ours.size === 0) return { label: '', free: false };
  const tt = new Set(tokenize(title).filter((t) => vocabSet.has(t)));
  for (const v of vocab) if (textHasToken(title, v)) tt.add(v);
  const tokens = [...tt];
  let best: { kw: string; j: number } | null = null;
  for (const t of ours.values()) {
    const j = overlap(tokens, t.tokens).jaccard;
    if (!best || j > best.j) best = { kw: t.kw, j };
  }
  if (!best || best.j < OVERLAP_MIN) return { label: '空き', free: true };
  return { label: `被り: ${best.kw}（${best.j.toFixed(2)}）`, free: false };
}

/* ── 5. レポート ── */
const isNew = (p: CompetitorPage) =>
  p.first_seen >= cutoff &&
  !(p.published_at !== '' && p.published_at < cutoff) &&
  !(p.published_at === '' && p.modified_at !== '' && p.modified_at < cutoff);
const isUpdated = (p: CompetitorPage) => !isNew(p) && p.modified_at !== '' && p.modified_at >= cutoff && p.modified_at !== p.published_at;

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\[/g, '［').replace(/\]/g, '］');
const link = (p: CompetitorPage) => `[${cell(p.title || p.url)}](${p.url})`;
const hostOf = (p: CompetitorPage) => siteById.get(p.site_id)?.host ?? `site#${p.site_id}`;

const reportSites = sites.filter((s) => !opts.site || s.host === opts.site).sort((a, b) => Math.abs(a.id) - Math.abs(b.id));
const reportPages = [...pages.values()].filter((p) => reportSites.some((s) => s.id === p.site_id));
const fresh = reportPages.filter(isNew).sort((a, b) => (b.published_at || b.first_seen).localeCompare(a.published_at || a.first_seen) || b.url.localeCompare(a.url));
const updated = reportPages.filter(isUpdated).sort((a, b) => b.modified_at.localeCompare(a.modified_at) || b.url.localeCompare(a.url));
const withTraffic = reportPages.filter((p) => p.traffic !== null).sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0));

const out: string[] = [];
out.push(`# 競合の記事観測 ${today}`);
out.push('');
out.push(`> 伸びているかは Ahrefs が無いと分からない。ここで分かるのは、何を書き足しているか（新着）と何を直しているか（更新）。`);
out.push(`> 期間: ${cutoff} 以降（--days ${opts.days}）／ 自社との重なりは台帳（dropped 以外）${ours.size} 件の KW とのトークン重なり。${OVERLAP_MIN} 未満は「空き」`);
out.push('');
out.push('## サイト別サマリ');
out.push('');
out.push('| サイト | アダプタ | 観測記事数 | 新着 | 更新 | 最終取得 |');
out.push('|---|---|--:|--:|--:|---|');
for (const s of reportSites) {
  const mine = reportPages.filter((p) => p.site_id === s.id);
  const name = `${s.host}${s.label ? `（${s.label}）` : ''}${s.active ? '' : ' 停止中'}`;
  out.push(`| ${cell(name)} | ${s.adapter} | ${mine.length} | ${mine.filter(isNew).length} | ${mine.filter(isUpdated).length} | ${s.fetched_at || '—'} |`);
}
out.push('');
out.push(`## 新着記事（${fresh.length} 件）`);
out.push('');
if (fresh.length === 0) out.push('なし');
else {
  out.push('| サイト | タイトル | 公開日 | 自社との重なり |');
  out.push('|---|---|---|---|');
  for (const p of fresh.slice(0, ROW_CAP)) out.push(`| ${hostOf(p)} | ${link(p)} | ${p.published_at || (p.modified_at ? `（更新 ${p.modified_at}）` : '—')} | ${cell(overlapLabel(p.title).label)} |`);
  if (fresh.length > ROW_CAP) out.push(`\n（残り ${fresh.length - ROW_CAP} 件は D1 の competitor_pages を見る）`);
}
out.push('');
out.push(`## 更新された記事（${updated.length} 件）`);
out.push('');
if (updated.length === 0) out.push('なし');
else {
  out.push('| サイト | タイトル | 更新日 | 公開日 | 自社との重なり |');
  out.push('|---|---|---|---|---|');
  for (const p of updated.slice(0, ROW_CAP)) out.push(`| ${hostOf(p)} | ${link(p)} | ${p.modified_at} | ${p.published_at || '—'} | ${cell(overlapLabel(p.title).label)} |`);
  if (updated.length > ROW_CAP) out.push(`\n（残り ${updated.length - ROW_CAP} 件は D1 の competitor_pages を見る）`);
}
if (withTraffic.length > 0) {
  out.push('');
  out.push(`## トラフィック上位 ${Math.min(TRAFFIC_TOP, withTraffic.length)}（Ahrefs。traffic がある ${withTraffic.length} 件から）`);
  out.push('');
  out.push('| サイト | タイトル | 月間流入 | 主要KW | 取得日 | 自社との重なり |');
  out.push('|---|---|--:|---|---|---|');
  for (const p of withTraffic.slice(0, TRAFFIC_TOP)) {
    out.push(`| ${hostOf(p)} | ${link(p)} | ${p.traffic} | ${cell(p.top_keyword || '—')} | ${p.traffic_at || '—'} | ${cell(overlapLabel(p.title).label)} |`);
  }
}
const seeds = [...new Set([...fresh, ...updated].filter((p) => p.title && overlapLabel(p.title).free).map((p) => p.title))];
out.push('');
out.push(`## 種KW候補（自社の台帳に無い題材。${seeds.length} 件）`);
out.push('');
out.push(seeds.length ? seeds.join('\n') : 'なし');
out.push('');

const report = out.join('\n');
console.log('');
console.log(report);

if (write) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, `記事観測_${today}.md`);
  writeFileSync(path, report, 'utf8');
  console.log(`レポート: ${path}`);
} else console.log('--dry-run: レポートファイルは書かない');
