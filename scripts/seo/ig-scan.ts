/**
 * 競合の Instagram 投稿を観測する。取った数字を D1（competitor_accounts / competitor_posts / competitor_post_stats）に貯め、
 * 「どの題材が伸びたか」のレポート（記事管理/競合/IG観測_<日付>.md）を出す。管理画面（/admin/competitors）は同じ D1 を読むだけ。
 * 物差しは src/lib/seo/competitor.ts（SNS戦略.md 4章「伸びている投稿の分解」「勝ちパターン6則」を機械に写したもの）。
 *
 *   node --experimental-strip-types scripts/seo/ig-scan.ts                          # targets.json を同期 → API で取る → D1 に書く → レポート
 *   node --experimental-strip-types scripts/seo/ig-scan.ts --hashtags               # targets.json の hashtags も叩く（App Review 後にだけ動く）
 *   node --experimental-strip-types scripts/seo/ig-scan.ts --template > 手入力.json   # --import 用の雛形
 *   node --experimental-strip-types scripts/seo/ig-scan.ts --import 手入力.json      # 手で見た数字を取り込む（API と併用できる）
 *   node --experimental-strip-types scripts/seo/ig-scan.ts --report-only            # 取得せず D1 の中身からレポートだけ
 *   node --experimental-strip-types scripts/seo/ig-scan.ts --dry-run                # 取得して表示するだけ。D1 に書かない
 *
 * 取り方（調べた事実。2026-09）：
 *   競合の投稿を公式に取れるのは **Instagram API with Facebook Login（graph.facebook.com）の Business Discovery** だけ。
 *   multi-SNS-manager の Instagram Login 方式（graph.instagram.com）のトークンは流用できない。
 *     GET https://graph.facebook.com/v21.0/{IG_BUSINESS_ID}
 *         ?fields=business_discovery.username({handle}){followers_count,media_count,
 *                 media.limit(N){id,caption,media_type,permalink,timestamp,like_count,comments_count}}
 *         &access_token=…
 *   対象がビジネス／クリエイターのときだけ返る。個人アカウントはエラー（「取れない」と1行出して続行）。
 *   アプリ管理者なら App Review 無しで動く。レート制限は 200回/時（アカウント1つ＝1リクエスト。間に 1 秒置く）。
 *   リールの再生数は Business Discovery では取れない（view_count は null のまま）。
 *
 *   Hashtag Search（ig_hashtag_search → /{hashtag-id}/top_media）は **App Review（Public Content Access）が通るまで使えない**。
 *   権限エラーならそう出して飛ばす。週 30 ハッシュタグの上限（超えたら先頭 30 で切って警告）。投稿に username が付かないので
 *   `#<tag>` の疑似アカウント（kind='other'）に紐づけ、source='hashtag'。アカウント内の中央値は持たない（competitor.ts）。
 *
 * 鍵は .dev.vars の IG_GRAPH_TOKEN（ページトークン）と IG_BUSINESS_ID（@anniv.gift の IG ビジネス ID）。
 * 無ければ API は飛ばし、targets 同期・--import・レポートだけ動く（exit 0）。設定は メディア方針/SNS戦略.md「競合の観測」。
 *
 * D1 に書くもの（wrangler で直接。_d1.ts）：
 *   competitor_accounts   … targets.json の accounts を毎回 upsert（UNIQUE(platform, handle)。label/kind/active/note は JSON が勝つ。
 *                           followers/media_count/fetched_at は API が更新する。JSON に無い handle は消さない）
 *   competitor_posts      … 投稿。first_seen は初回だけ、fetched_at は毎回、数字は最新で上書き。
 *                           同じ media id が hashtag → api の順で来たら api 側（本来のアカウント）に付け替える
 *   competitor_post_stats … 今日（JST）の断面。同じ日は上書き。前回比（delta）はここから
 *   1件1文を lit() で組み、d1Many で 100 文ずつ流す（wrangler の起動は1回3〜5秒）。account_id は handle からの副問い合わせで埋めるので、
 *   同じ回で作ったアカウントの id を知らなくていい。
 *
 * オプション：
 *   --limit <n>       アカウントごとの投稿件数（既定 30、上限 50）
 *   --hashtags        targets.json の hashtags も叩く
 *   --import <json>   手で見た数字を取り込む（形は --template）。id は manual:<shortcode>、source='manual'
 *   --template        --import 用の空 JSON を標準出力に
 *   --report-only     取得せず D1 の中身からレポートだけ
 *   --dry-run         取得して表示するだけ。D1 に書かない（レポートのファイルは出す）
 *   --local           ローカル D1（既定は本番）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { patternSummary, scorePosts, topPosts } from '../../src/lib/seo/competitor.ts';
import type {
  CompetitorAccount,
  CompetitorKind,
  CompetitorPost,
  CompetitorPostStat,
  CompetitorTargets,
  PostScore,
} from '../../src/lib/seo/types.ts';
import { ROOT, d1Many, die, lit, takeCommonFlag } from './_d1.ts';
import { jstToday, readDevVars } from './_env.ts';

/* ────────────────────────────────────────────────
 * 設定
 * ──────────────────────────────────────────────── */

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PLATFORM = 'instagram';
const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 50;
/** Hashtag Search はアカウントごとに週 30 タグまで */
const HASHTAG_WEEKLY_MAX = 30;
/** リクエスト間のウェイト（ms）。200回/時なので余裕はあるが、詰めない */
const WAIT_MS = 1000;
/** d1Many に一度に渡す文の数 */
const SQL_CHUNK = 100;
const TOP_N = 15;
const DELTA_N = 5;
const TERRITORY_MAX = 30;
/** 表のフック列の上限（文字）。hookOf は 120 字まで返すが、表では長い */
const HOOK_CELL_MAX = 60;

const KINDS: readonly CompetitorKind[] = ['couple_media', 'gift_media', 'vendor', 'concierge', 'other'];
const KIND_LABEL: Record<CompetitorKind | '', string> = {
  couple_media: 'カップル発信',
  gift_media: 'ギフト選定',
  vendor: '演出ベンダー',
  concierge: '同業',
  other: 'その他',
  '': '—',
};
const MEDIA_LABEL: Record<string, string> = { IMAGE: '画像', VIDEO: 'リール', CAROUSEL_ALBUM: 'カルーセル' };
const MEDIA_FIELDS = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';

const TARGETS_PATH = join(ROOT, '記事管理', '競合', 'targets.json');
const REPORT_DIR = join(ROOT, '記事管理', '競合');

const NO_KEY_GUIDE = [
  'Instagram Graph API の鍵が無い（.dev.vars の IG_GRAPH_TOKEN と IG_BUSINESS_ID）。API は飛ばして、targets 同期・--import・レポートだけ動かす。',
  '  設定は メディア方針/SNS戦略.md「競合の観測」。手で取り込むなら --template で雛形を出して --import <json>',
].join('\n');
const APP_REVIEW_GUIDE = '  Hashtag Search は App Review（Public Content Access）が通るまで使えない。ハッシュタグは飛ばす';

/** --template で出す雛形。_comment は取り込み時に読み飛ばす */
const TEMPLATE = [
  {
    _comment:
      '1投稿1要素。handle は @ なし。permalink は /p/ か /reel/ の URL（id はここから manual:<shortcode> になる）。' +
      'like_count / comments_count は非公開なら null。media_type は IMAGE / VIDEO / CAROUSEL_ALBUM。posted_at は YYYY-MM-DD。この _comment は消してよい',
    handle: 'gift_psypre',
    permalink: 'https://www.instagram.com/p/XXXX/',
    caption: 'シーン別 サプライズアイデア35選\n（キャプションの冒頭数行。表紙の見出しが入っていれば十分）',
    like_count: 118,
    comments_count: 3,
    media_type: 'CAROUSEL_ALBUM',
    posted_at: '2026-08-20',
  },
];

/* ────────────────────────────────────────────────
 * オプション
 * ──────────────────────────────────────────────── */

interface Options {
  limit: number;
  hashtags: boolean;
  importFile: string;
  template: boolean;
  reportOnly: boolean;
  dryRun: boolean;
  local: boolean;
}

function parseArgs(argv: string[]): Options {
  const local = takeCommonFlag(argv, '--local');
  const hashtags = takeCommonFlag(argv, '--hashtags');
  const template = takeCommonFlag(argv, '--template');
  const reportOnly = takeCommonFlag(argv, '--report-only');
  const dryRun = takeCommonFlag(argv, '--dry-run');
  const o: Options = { limit: LIMIT_DEFAULT, hashtags, importFile: '', template, reportOnly, dryRun, local };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) die(`--limit は 1〜${LIMIT_MAX} の整数`);
      o.limit = n;
    } else if (a === '--import') {
      o.importFile = (argv[++i] ?? '').trim();
      if (!o.importFile) die('--import にはファイルを渡す（雛形は --template）');
    } else die(`知らないオプション: ${a}`);
  }
  if (o.reportOnly && (o.importFile || o.dryRun || o.hashtags)) die('--report-only は --import / --dry-run / --hashtags と併用できない');
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[,，]/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const normHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

/* ────────────────────────────────────────────────
 * 入力（targets.json ／ --import）
 * ──────────────────────────────────────────────── */

function loadTargets(): CompetitorTargets {
  if (!existsSync(TARGETS_PATH)) die(`${TARGETS_PATH} が無い（観測対象の一覧。CLAUDE.md の 記事管理/競合/）`);
  let t: CompetitorTargets;
  try {
    t = JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as CompetitorTargets;
  } catch (e) {
    return die(`targets.json を読めない: ${(e as Error).message}`);
  }
  if (!Array.isArray(t.accounts)) die('targets.json の accounts が配列でない');
  for (const a of t.accounts) {
    if (typeof a.handle !== 'string' || !a.handle.trim()) die('targets.json: handle が空の account がある');
    if (a.kind !== undefined && !KINDS.includes(a.kind)) die(`targets.json: @${a.handle} の kind「${a.kind}」は ${KINDS.join(' / ')} のどれか`);
  }
  if (t.hashtags !== undefined && !Array.isArray(t.hashtags)) die('targets.json の hashtags が配列でない');
  return t;
}

/** 投稿1本の入力（account_id と first_seen / fetched_at は recordPost が付ける） */
type PostInput = Omit<CompetitorPost, 'account_id' | 'first_seen' | 'fetched_at'>;

interface ImportRow {
  handle: string;
  post: PostInput;
}

/**
 * --import の JSON を読む。permalink から shortcode を取り、id を manual:<shortcode> にする。
 * 直せる不備（数字の桁区切り・@付き handle・末尾スラッシュ無し）は直し、直せないものは全部集めてから止まる。
 */
function loadImport(path: string): ImportRow[] {
  if (!existsSync(path)) die(`--import のファイルが無い: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return die(`--import の JSON を読めない: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) die('--import の JSON は配列（--template の形）');

  const errors: string[] = [];
  const rows: ImportRow[] = [];
  raw.forEach((r: any, i: number) => {
    const at = `[${i}]`;
    if (!r || typeof r !== 'object') return errors.push(`${at} オブジェクトでない`);
    const handle = normHandle(String(r.handle ?? ''));
    if (!handle) errors.push(`${at} handle が空`);
    const link = String(r.permalink ?? '').trim();
    const m = link.match(/instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) errors.push(`${at} permalink から shortcode が取れない（https://www.instagram.com/p/XXXX/ の形）: ${link || '(空)'}`);
    const like = r.like_count === undefined ? null : numOrNull(r.like_count);
    if (r.like_count !== undefined && r.like_count !== null && like === null) errors.push(`${at} like_count が数字でない: ${r.like_count}`);
    const comments = r.comments_count === undefined ? null : numOrNull(r.comments_count);
    if (r.comments_count !== undefined && r.comments_count !== null && comments === null) errors.push(`${at} comments_count が数字でない: ${r.comments_count}`);
    const views = r.view_count === undefined ? null : numOrNull(r.view_count);
    let posted = String(r.posted_at ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(posted)) posted = `${posted}T00:00:00+09:00`;
    else if (posted && Number.isNaN(Date.parse(posted))) errors.push(`${at} posted_at が日付でない（YYYY-MM-DD）: ${posted}`);
    if (!m) return;
    const kind = m[1] === 'reels' ? 'reel' : m[1]!;
    const code = m[2]!;
    rows.push({
      handle,
      post: {
        id: `manual:${code}`,
        media_type: String(r.media_type ?? '').trim().toUpperCase(),
        caption: String(r.caption ?? ''),
        permalink: `https://www.instagram.com/${kind}/${code}/`,
        posted_at: posted,
        like_count: like,
        comments_count: comments,
        view_count: views,
        source: 'manual',
      },
    });
  });
  if (errors.length) die(`--import の内容に不備:\n  ${errors.join('\n  ')}`);
  return rows;
}

/* ────────────────────────────────────────────────
 * 状態（D1 の写し＋この回の差分）と SQL
 *
 * D1 は最初に1回読み、この回で取ったものはメモリに重ねながら SQL を積む。最後にまとめて流す。
 * dry-run は SQL を流さないだけで、レポートは同じメモリから出す。
 * ──────────────────────────────────────────────── */

interface State {
  /** handle → アカウント。D1 に無い新規は負の仮 id（D1 側は副問い合わせで本物の id が入る） */
  accounts: Map<string, CompetitorAccount>;
  /** post id → 投稿 */
  posts: Map<string, CompetitorPost>;
  /** post id → 断面（ymd 昇順とは限らない。competitor.ts が並べ直す） */
  stats: Map<string, CompetitorPostStat[]>;
  /** 流す SQL（積んだ順） */
  sql: string[];
}

let tempId = 0;

function runSql(sqls: string[], local: boolean): void {
  for (let i = 0; i < sqls.length; i += SQL_CHUNK) d1Many(sqls.slice(i, i + SQL_CHUNK), { local });
}

function loadState(local: boolean): State {
  const [acc, posts, stats] = d1Many(
    [
      `SELECT id, platform, handle, label, kind, active, followers, media_count, fetched_at, note FROM competitor_accounts WHERE platform=${lit(PLATFORM)} ORDER BY id`,
      `SELECT p.id, p.account_id, p.media_type, p.caption, p.permalink, p.posted_at, p.like_count, p.comments_count, p.view_count, p.source, p.first_seen, p.fetched_at
         FROM competitor_posts p JOIN competitor_accounts a ON a.id = p.account_id WHERE a.platform=${lit(PLATFORM)}`,
      `SELECT s.post_id, s.ymd, s.like_count, s.comments_count, s.view_count
         FROM competitor_post_stats s JOIN competitor_posts p ON p.id = s.post_id JOIN competitor_accounts a ON a.id = p.account_id
        WHERE a.platform=${lit(PLATFORM)} ORDER BY s.ymd`,
    ],
    { local },
  );
  const state: State = { accounts: new Map(), posts: new Map(), stats: new Map(), sql: [] };
  for (const r of acc as any[]) {
    state.accounts.set(String(r.handle), {
      id: Number(r.id),
      platform: String(r.platform ?? PLATFORM),
      handle: String(r.handle),
      label: String(r.label ?? ''),
      kind: (KINDS as readonly string[]).includes(String(r.kind ?? '')) ? (r.kind as CompetitorKind) : '',
      active: Number(r.active ?? 1),
      followers: numOrNull(r.followers),
      media_count: numOrNull(r.media_count),
      fetched_at: String(r.fetched_at ?? ''),
      note: String(r.note ?? ''),
    });
  }
  for (const r of posts as any[]) {
    const source = String(r.source ?? 'api');
    state.posts.set(String(r.id), {
      id: String(r.id),
      account_id: Number(r.account_id),
      media_type: String(r.media_type ?? ''),
      caption: String(r.caption ?? ''),
      permalink: String(r.permalink ?? ''),
      posted_at: String(r.posted_at ?? ''),
      like_count: numOrNull(r.like_count),
      comments_count: numOrNull(r.comments_count),
      view_count: numOrNull(r.view_count),
      source: source === 'manual' || source === 'hashtag' ? source : 'api',
      first_seen: String(r.first_seen ?? ''),
      fetched_at: String(r.fetched_at ?? ''),
    });
  }
  for (const r of stats as any[]) {
    const id = String(r.post_id);
    const list = state.stats.get(id) ?? [];
    list.push({ post_id: id, ymd: String(r.ymd), like_count: numOrNull(r.like_count), comments_count: numOrNull(r.comments_count), view_count: numOrNull(r.view_count) });
    state.stats.set(id, list);
  }
  return state;
}

interface AccountInit {
  label: string;
  kind: CompetitorKind | '';
  active: number;
  note: string;
}

function accountUpsertSql(handle: string, init: AccountInit, mode: 'sync' | 'ignore', now: string): string {
  const base =
    `INSERT INTO competitor_accounts (platform, handle, label, kind, active, note, created_at) ` +
    `VALUES (${lit(PLATFORM)}, ${lit(handle)}, ${lit(init.label)}, ${lit(init.kind)}, ${init.active}, ${lit(init.note)}, ${lit(now)})`;
  return mode === 'sync'
    ? `${base} ON CONFLICT(platform, handle) DO UPDATE SET label=excluded.label, kind=excluded.kind, active=excluded.active, note=excluded.note`
    : `${base} ON CONFLICT(platform, handle) DO NOTHING`;
}

/**
 * アカウントをメモリと SQL の両方に用意する。
 *   sync   … targets.json の行。label/kind/active/note を JSON で上書き（毎回）
 *   ignore … --import や hashtag で出てきた handle。無ければ作る、あれば触らない
 */
function ensureAccount(state: State, handle: string, init: AccountInit, mode: 'sync' | 'ignore', now: string): CompetitorAccount {
  let acc = state.accounts.get(handle);
  if (acc) {
    if (mode === 'ignore') return acc;
    acc.label = init.label;
    acc.kind = init.kind;
    acc.active = init.active;
    acc.note = init.note;
  } else {
    acc = { id: --tempId, platform: PLATFORM, handle, label: init.label, kind: init.kind, active: init.active, followers: null, media_count: null, fetched_at: '', note: init.note };
    state.accounts.set(handle, acc);
  }
  state.sql.push(accountUpsertSql(handle, init, mode, now));
  return acc;
}

/** API で取れたフォロワー数・投稿数をアカウントに載せる */
function touchAccount(state: State, acc: CompetitorAccount, followers: number | null, mediaCount: number | null, now: string): void {
  acc.followers = followers;
  acc.media_count = mediaCount;
  acc.fetched_at = now;
  state.sql.push(
    `UPDATE competitor_accounts SET followers=${lit(followers)}, media_count=${lit(mediaCount)}, fetched_at=${lit(now)} WHERE platform=${lit(PLATFORM)} AND handle=${lit(acc.handle)}`,
  );
}

/** hashtag で先に入った投稿が本来のアカウント（api）で取れたら付け替える。それ以外は既存の紐づけを守る */
const SOURCE_CASE = (col: string) => `CASE WHEN competitor_posts.source='hashtag' AND excluded.source<>'hashtag' THEN excluded.${col} ELSE competitor_posts.${col} END`;

function postUpsertSql(p: CompetitorPost, handle: string): string {
  const accountId = `(SELECT id FROM competitor_accounts WHERE platform=${lit(PLATFORM)} AND handle=${lit(handle)})`;
  return (
    `INSERT INTO competitor_posts (id, account_id, media_type, caption, permalink, posted_at, like_count, comments_count, view_count, source, first_seen, fetched_at) ` +
    `VALUES (${lit(p.id)}, ${accountId}, ${lit(p.media_type)}, ${lit(p.caption)}, ${lit(p.permalink)}, ${lit(p.posted_at)}, ${lit(p.like_count)}, ${lit(p.comments_count)}, ${lit(p.view_count)}, ${lit(p.source)}, ${lit(p.first_seen)}, ${lit(p.fetched_at)}) ` +
    `ON CONFLICT(id) DO UPDATE SET media_type=excluded.media_type, caption=excluded.caption, permalink=excluded.permalink, posted_at=excluded.posted_at, ` +
    `like_count=excluded.like_count, comments_count=excluded.comments_count, view_count=excluded.view_count, fetched_at=excluded.fetched_at, ` +
    `account_id=${SOURCE_CASE('account_id')}, source=${SOURCE_CASE('source')}`
  );
}

function statUpsertSql(s: CompetitorPostStat): string {
  return (
    `INSERT INTO competitor_post_stats (post_id, ymd, like_count, comments_count, view_count) ` +
    `VALUES (${lit(s.post_id)}, ${lit(s.ymd)}, ${lit(s.like_count)}, ${lit(s.comments_count)}, ${lit(s.view_count)}) ` +
    `ON CONFLICT(post_id, ymd) DO UPDATE SET like_count=excluded.like_count, comments_count=excluded.comments_count, view_count=excluded.view_count`
  );
}

/**
 * 投稿1本をメモリに重ね、posts の upsert と今日の断面を SQL に積む。
 * 既存なら first_seen は残し、数字と fetched_at を最新にする。同じ日の断面は上書き。
 */
function recordPost(state: State, handle: string, input: PostInput, now: string, ymd: string): void {
  const acc = state.accounts.get(handle);
  if (!acc) die(`内部エラー: @${handle} のアカウントが用意されていない`);
  const cur = state.posts.get(input.id);
  let post: CompetitorPost;
  if (cur) {
    const rebind = cur.source === 'hashtag' && input.source !== 'hashtag';
    post = {
      ...cur,
      media_type: input.media_type,
      caption: input.caption,
      permalink: input.permalink,
      posted_at: input.posted_at,
      like_count: input.like_count,
      comments_count: input.comments_count,
      view_count: input.view_count,
      fetched_at: now,
      account_id: rebind ? acc.id : cur.account_id,
      source: rebind ? input.source : cur.source,
    };
  } else {
    post = { ...input, account_id: acc.id, first_seen: now, fetched_at: now };
  }
  state.posts.set(post.id, post);

  const stat: CompetitorPostStat = { post_id: post.id, ymd, like_count: input.like_count, comments_count: input.comments_count, view_count: input.view_count };
  const list = state.stats.get(post.id) ?? [];
  const i = list.findIndex((s) => s.ymd === ymd);
  if (i >= 0) list[i] = stat;
  else list.push(stat);
  state.stats.set(post.id, list);

  state.sql.push(postUpsertSql(post, handle), statUpsertSql(stat));
}

/* ────────────────────────────────────────────────
 * Graph API
 * ──────────────────────────────────────────────── */

interface GraphError {
  code: number;
  subcode: number | null;
  type: string;
  message: string;
}
type GraphResult = { ok: true; data: any } | { ok: false; error: GraphError };

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<GraphResult> {
  const url = `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body: any = await res.json().catch(() => ({}));
    if (body && typeof body === 'object' && body.error) {
      const e = body.error;
      return { ok: false, error: { code: Number(e.code ?? -1), subcode: e.error_subcode === undefined ? null : Number(e.error_subcode), type: String(e.type ?? ''), message: String(e.message ?? '') } };
    }
    if (!res.ok) return { ok: false, error: { code: res.status, subcode: null, type: 'http', message: `HTTP ${res.status}` } };
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, error: { code: -1, subcode: null, type: 'network', message: (e as Error).message } };
  }
}

/** 4=アプリ上限 / 17=ユーザー上限 / 32=ページ上限 / 613=カスタム上限 */
const isRateLimit = (e: GraphError) => [4, 17, 32, 613].includes(e.code);
/** 10=権限なし / 200=パーミッション / 3=機能未承認。Hashtag Search は App Review 前だとここに落ちる */
const isPermission = (e: GraphError) => [3, 10, 200].includes(e.code) || /permission|public content|app review/i.test(e.message);
const errText = (e: GraphError) => `#${e.code}${e.subcode !== null ? `/${e.subcode}` : ''} ${e.message}`;

function fromMedia(m: any, source: CompetitorPost['source']): PostInput | null {
  const id = String(m?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    media_type: String(m.media_type ?? ''),
    caption: String(m.caption ?? ''),
    permalink: String(m.permalink ?? ''),
    posted_at: String(m.timestamp ?? ''),
    like_count: numOrNull(m.like_count),
    comments_count: numOrNull(m.comments_count),
    view_count: null,
    source,
  };
}

interface RunInfo {
  api: number;
  apiPosts: number;
  apiFailed: number;
  hashtag: number;
  hashtagPosts: number;
  manual: number;
}

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('ja-JP'));

/** Business Discovery。アカウントごと1リクエスト */
async function fetchAccounts(state: State, handles: string[], token: string, bizId: string, limit: number, now: string, ymd: string, run: RunInfo): Promise<void> {
  console.log(`API: Business Discovery（${GRAPH_VERSION}）で ${handles.length} アカウント、各 ${limit} 件`);
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i]!;
    if (i > 0) await sleep(WAIT_MS);
    const fields = `business_discovery.username(${handle}){followers_count,media_count,media.limit(${limit}){${MEDIA_FIELDS}}}`;
    const res = await graphGet(bizId, { fields }, token);
    if (!res.ok) {
      const e = res.error;
      if (isRateLimit(e)) {
        console.log(`  レート制限（${errText(e)}）。残り ${handles.length - i} アカウントは次回に回す`);
        run.apiFailed += handles.length - i;
        return;
      }
      if (e.code === 190) {
        console.log(`  トークンが無効（${errText(e)}）。.dev.vars の IG_GRAPH_TOKEN を更新する。残り ${handles.length - i} アカウントは飛ばす`);
        run.apiFailed += handles.length - i;
        return;
      }
      console.log(`  @${handle} … 取れない（${errText(e)}。ビジネス／クリエイターでないか、存在しない）`);
      run.apiFailed++;
      continue;
    }
    const bd = res.data?.business_discovery ?? {};
    const media: any[] = Array.isArray(bd.media?.data) ? bd.media.data : [];
    const acc = state.accounts.get(handle);
    if (!acc) die(`内部エラー: @${handle} が同期されていない`);
    touchAccount(state, acc, numOrNull(bd.followers_count), numOrNull(bd.media_count), now);
    let n = 0;
    for (const m of media) {
      const p = fromMedia(m, 'api');
      if (!p) continue;
      recordPost(state, handle, p, now, ymd);
      n++;
    }
    run.api++;
    run.apiPosts += n;
    console.log(`  @${handle} … ${n} 件（フォロワー ${fmt(acc.followers)}・投稿数 ${fmt(acc.media_count)}）`);
  }
}

/** Hashtag Search → top_media。App Review 前は権限エラーで全部飛ばす */
async function fetchHashtags(state: State, tags: string[], token: string, bizId: string, limit: number, now: string, ymd: string, run: RunInfo): Promise<void> {
  let list = tags.map((t) => t.replace(/^[#＃]/, '').trim()).filter(Boolean);
  if (list.length === 0) {
    console.log('API: targets.json に hashtags が無い');
    return;
  }
  if (list.length > HASHTAG_WEEKLY_MAX) {
    console.log(`  警告: hashtags が ${list.length} 件。Hashtag Search は週 ${HASHTAG_WEEKLY_MAX} タグまでなので先頭 ${HASHTAG_WEEKLY_MAX} 件だけ叩く`);
    list = list.slice(0, HASHTAG_WEEKLY_MAX);
  }
  console.log(`API: Hashtag Search で ${list.length} タグ、各 ${limit} 件`);
  for (const tag of list) {
    await sleep(WAIT_MS);
    const s = await graphGet('ig_hashtag_search', { user_id: bizId, q: tag }, token);
    if (!s.ok) {
      if (isPermission(s.error)) {
        console.log(`  #${tag} … ${errText(s.error)}\n${APP_REVIEW_GUIDE}`);
        return;
      }
      if (isRateLimit(s.error)) {
        console.log(`  レート制限（${errText(s.error)}）。残りのタグは次回に回す`);
        return;
      }
      console.log(`  #${tag} … 取れない（${errText(s.error)}）`);
      continue;
    }
    const hashtagId = String(s.data?.data?.[0]?.id ?? '');
    if (!hashtagId) {
      console.log(`  #${tag} … ハッシュタグが見つからない`);
      continue;
    }
    await sleep(WAIT_MS);
    const t = await graphGet(`${hashtagId}/top_media`, { user_id: bizId, fields: MEDIA_FIELDS, limit: String(limit) }, token);
    if (!t.ok) {
      if (isPermission(t.error)) {
        console.log(`  #${tag} … ${errText(t.error)}\n${APP_REVIEW_GUIDE}`);
        return;
      }
      console.log(`  #${tag} … top_media が取れない（${errText(t.error)}）`);
      continue;
    }
    const media: any[] = Array.isArray(t.data?.data) ? t.data.data : [];
    const handle = `#${tag}`;
    ensureAccount(state, handle, { label: handle, kind: 'other', active: 1, note: 'Hashtag Search の上位（疑似アカウント。username が付かないのでタグに紐づける）' }, 'ignore', now);
    let n = 0;
    for (const m of media) {
      const p = fromMedia(m, 'hashtag');
      if (!p) continue;
      recordPost(state, handle, p, now, ymd);
      n++;
    }
    run.hashtag++;
    run.hashtagPosts += n;
    console.log(`  #${tag} … ${n} 件`);
  }
}

/* ────────────────────────────────────────────────
 * レポート
 * ──────────────────────────────────────────────── */

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const cut = (s: string, n: number) => {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join('') + '…' : s;
};
const ratioStr = (r: number | null) => (r === null ? '—' : `×${r.toFixed(1)}`);
const deltaStr = (d: number | null) => (d === null ? '—' : d > 0 ? `+${d}` : String(d));
const mark = (b: boolean) => (b ? '○' : '');
const mediaLabel = (t: string) => MEDIA_LABEL[t] ?? (t || '—');
const pct = (h: number, t: number) => (t ? `${h}/${t}（${Math.round((h / t) * 100)}%）` : '—');
/** ISO8601 → JST の日付。読めなければ先頭 10 字 */
function ymdJst(iso: string): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso.slice(0, 10) : new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const acctCell = (a: CompetitorAccount) => (a.handle.startsWith('#') ? a.handle : `@${a.handle}`);

function buildReport(state: State, scores: PostScore[], ymd: string, run: RunInfo, opts: Options): string {
  const L: string[] = [];
  const bySource = { api: 0, manual: 0, hashtag: 0 };
  for (const s of scores) bySource[s.post.source]++;
  const top = topPosts(scores, TOP_N);

  L.push(`# IG観測 ${ymd}`);
  L.push('');
  L.push(`取得元：api ${bySource.api}件／manual ${bySource.manual}件／hashtag ${bySource.hashtag}件（アカウント ${state.accounts.size}・投稿 ${scores.length}。${opts.local ? 'ローカル' : '本番'} D1）`);
  L.push(
    `この回：API ${run.api} アカウント ${run.apiPosts} 本${run.apiFailed ? `（取れない ${run.apiFailed}）` : ''}／手動 ${run.manual} 本／ハッシュタグ ${run.hashtag} タグ ${run.hashtagPosts} 本` +
      (opts.reportOnly ? '（--report-only。取得していない）' : opts.dryRun ? '（--dry-run。D1 には書いていない）' : ''),
  );
  L.push('読み方：フォロワー数で比べない。同アカウント内の中央値比で見る（SNS戦略.md 4章）');
  L.push('');

  /* 1. アカウント別 */
  L.push('## 1. アカウント別サマリ');
  L.push('');
  L.push('| handle | 種別 | フォロワー | 観測本数 | 中央値 | 最終取得 |');
  L.push('|---|---|--:|--:|--:|---|');
  const accounts = [...state.accounts.values()].sort((a, b) => b.active - a.active || (b.followers ?? -1) - (a.followers ?? -1) || a.handle.localeCompare(b.handle));
  for (const a of accounts) {
    const mine = scores.filter((s) => s.account.id === a.id);
    const med = mine.find((s) => s.median !== null)?.median ?? null;
    const last = a.fetched_at || mine.map((s) => s.post.fetched_at).sort().at(-1) || '';
    L.push(
      `| ${cell(acctCell(a))}${a.active ? '' : '（休止）'}${a.label ? ` ${cell(a.label)}` : ''} | ${KIND_LABEL[a.kind]} | ${fmt(a.followers)} | ${mine.length} | ${fmt(med)} | ${ymdJst(last)} |`,
    );
  }
  if (accounts.length === 0) L.push('| （アカウントが無い） | | | | | |');
  L.push('');

  /* 2. 伸びた投稿 */
  L.push(`## 2. 伸びた投稿 上位${TOP_N}（同アカウント内の中央値比の降順）`);
  L.push('');
  L.push('| # | アカウント | フック | 種類 | いいね | コメント | 中央値比 | 前回比 | 相手 | 数字 | 誘導 | 独壇場 | 投稿日 | リンク |');
  L.push('|--:|---|---|---|--:|--:|--:|--:|:-:|:-:|:-:|:-:|---|---|');
  top.forEach((s, i) => {
    L.push(
      `| ${i + 1} | ${cell(acctCell(s.account))} | ${cell(cut(s.hook, HOOK_CELL_MAX))} | ${mediaLabel(s.post.media_type)} | ${fmt(s.post.like_count)} | ${fmt(s.post.comments_count)} | ${ratioStr(s.ratio)} | ${deltaStr(s.delta)} | ${mark(s.pattern.audience)} | ${mark(s.pattern.number)} | ${mark(s.pattern.profileCta)} | ${mark(s.pattern.annivTerritory)} | ${ymdJst(s.post.posted_at)} | ${s.post.permalink || '—'} |`,
    );
  });
  if (top.length === 0) L.push('| — | （投稿が無い） | | | | | | | | | | | | |');
  L.push('');
  L.push('中央値比が — の投稿は、そのアカウントの観測本数が 3 本未満か hashtag 経由（中央値を持たない）。');
  L.push('');

  /* 3. 前回から伸びた */
  L.push(`## 3. 前回から最も伸びた投稿 上位${DELTA_N}（いいねの増分）`);
  L.push('');
  const grown = scores.filter((s) => s.delta !== null).sort((a, b) => b.delta! - a.delta! || b.engagement - a.engagement).slice(0, DELTA_N);
  if (grown.length === 0) {
    L.push('（断面が1つしか無い投稿ばかりで前回比が出ない。次回以降に出る）');
  } else {
    L.push('| # | アカウント | フック | 前回比 | いいね | 中央値比 | 投稿日 | リンク |');
    L.push('|--:|---|---|--:|--:|--:|---|---|');
    grown.forEach((s, i) => {
      L.push(`| ${i + 1} | ${cell(acctCell(s.account))} | ${cell(cut(s.hook, HOOK_CELL_MAX))} | ${deltaStr(s.delta)} | ${fmt(s.post.like_count)} | ${ratioStr(s.ratio)} | ${ymdJst(s.post.posted_at)} | ${s.post.permalink || '—'} |`);
    });
  }
  L.push('');

  /* 4. パターン集計 */
  L.push('## 4. パターン集計（勝ちパターン6則のうちキャプションから見える4つ）');
  L.push('');
  L.push('| 群 | 相手明示（規則1・3） | 数字（規則1・3） | プロフィール誘導（規則5） | 独壇場（規則6） |');
  L.push('|---|---|---|---|---|');
  for (const [name, group] of [[`上位${TOP_N}`, top], ['全体', scores]] as const) {
    const p = patternSummary(group);
    L.push(`| ${name} | ${pct(p.audience.hit, p.audience.total)} | ${pct(p.number.hit, p.number.total)} | ${pct(p.profileCta.hit, p.profileCta.total)} | ${pct(p.annivTerritory.hit, p.annivTerritory.total)} |`);
  }
  L.push('');
  L.push('上位で全体より割合が高い項目が「効いている要素」。規則2（2枚目の保存理由）・規則4（締めの自己紹介）はスライドの中身なので機械では見ない。');
  L.push('');

  /* 5. 独壇場 */
  L.push('## 5. 独壇場フラグ（規則6：店・締切・予算の内訳・段取りに触れている投稿）');
  L.push('');
  const territory = scores.filter((s) => s.pattern.annivTerritory);
  if (territory.length === 0) {
    L.push('（該当なし。競合はまだ Anniv の領域に踏み込んでいない）');
  } else {
    L.push('| # | アカウント | フック | いいね | 中央値比 | 投稿日 | リンク |');
    L.push('|--:|---|---|--:|--:|---|---|');
    territory.slice(0, TERRITORY_MAX).forEach((s, i) => {
      L.push(`| ${i + 1} | ${cell(acctCell(s.account))} | ${cell(cut(s.hook, HOOK_CELL_MAX))} | ${fmt(s.post.like_count)} | ${ratioStr(s.ratio)} | ${ymdJst(s.post.posted_at)} | ${s.post.permalink || '—'} |`);
    });
    if (territory.length > TERRITORY_MAX) L.push(`\n（他 ${territory.length - TERRITORY_MAX} 件）`);
    L.push('');
    L.push('ここに出た投稿は「競合が Anniv の独壇場に来た」警戒フラグ。中央値比が高ければ、その題材は読者にも刺さっている。');
  }
  L.push('');
  return L.join('\n');
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2));

if (opts.template) {
  console.log(JSON.stringify(TEMPLATE, null, 2));
  process.exit(0);
}

const now = new Date().toISOString();
const ymd = jstToday();
const dbLabel = opts.local ? 'ローカル' : '本番';
const writing = !opts.dryRun && !opts.reportOnly;

const targets = loadTargets();
const importRows = opts.importFile ? loadImport(resolve(opts.importFile)) : [];

/* ── D1 の現状 ── */
const state = loadState(opts.local);
const statRows = [...state.stats.values()].reduce((n, l) => n + l.length, 0);
console.log(`D1（${dbLabel}）: アカウント ${state.accounts.size} 件・投稿 ${state.posts.size} 件・断面 ${statRows} 行`);

const run: RunInfo = { api: 0, apiPosts: 0, apiFailed: 0, hashtag: 0, hashtagPosts: 0, manual: 0 };

if (!opts.reportOnly) {
  /* ── targets 同期（JSON が勝つ。JSON に無い handle は消さない） ── */
  for (const t of targets.accounts) {
    ensureAccount(state, normHandle(t.handle), { label: t.label ?? '', kind: t.kind ?? '', active: t.active === false ? 0 : 1, note: t.note ?? '' }, 'sync', now);
  }
  console.log(`同期: targets.json → competitor_accounts ${targets.accounts.length} 件${writing ? '' : '（メモリ上だけ）'}`);

  /* ── API ── */
  const env = readDevVars(['IG_GRAPH_TOKEN', 'IG_BUSINESS_ID']);
  const token = env.IG_GRAPH_TOKEN ?? '';
  const bizId = env.IG_BUSINESS_ID ?? '';
  if (!token || !bizId) {
    console.log(NO_KEY_GUIDE);
  } else {
    const handles = targets.accounts.filter((a) => a.active !== false).map((a) => normHandle(a.handle));
    await fetchAccounts(state, handles, token, bizId, opts.limit, now, ymd, run);
    if (opts.hashtags) await fetchHashtags(state, targets.hashtags ?? [], token, bizId, opts.limit, now, ymd, run);
  }

  /* ── 手動取込 ── */
  if (importRows.length) {
    const newHandles = new Set<string>();
    for (const r of importRows) {
      if (!state.accounts.has(r.handle)) newHandles.add(r.handle);
      ensureAccount(state, r.handle, { label: '', kind: '', active: 1, note: 'targets.json に無い（--import で追加）' }, 'ignore', now);
      recordPost(state, r.handle, r.post, now, ymd);
      run.manual++;
    }
    console.log(`取込: ${opts.importFile} から ${importRows.length} 本（アカウント ${new Set(importRows.map((r) => r.handle)).size}${newHandles.size ? `、うち targets.json に無い ${[...newHandles].map((h) => `@${h}`).join('・')}` : ''}）`);
  }

  /* ── D1 に書く ── */
  if (writing) {
    if (state.sql.length) {
      runSql(state.sql, opts.local);
      console.log(`D1（${dbLabel}）に ${state.sql.length} 文を書いた（${Math.ceil(state.sql.length / SQL_CHUNK)} 回）`);
    } else {
      console.log('D1 に書くものが無い');
    }
  } else {
    console.log(`dry-run: D1 には書いていない（${state.sql.length} 文ぶん）`);
  }
}

/* ── レポート ── */
const scores = scorePosts([...state.posts.values()], [...state.accounts.values()], state.stats);
const report = buildReport(state, scores, ymd, run, opts);
mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `IG観測_${ymd}.md`);
writeFileSync(reportPath, report, 'utf8');

console.log('');
console.log(report);
console.log(`レポート: ${reportPath}`);
if (scores.length === 0) {
  console.log('投稿が 1 本も無い。鍵を設定して API で取るか、--template → --import で手で入れる');
}
