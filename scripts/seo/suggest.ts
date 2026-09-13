/**
 * Google 補完API でサジェストを展開し、台帳・記事と突合して「まだ書いていない候補」を洗い出す。
 * /anniv-pick-keyword の最初の工程。爆速開発部の suggest_keywords.py の D1 版。
 *
 *   node --experimental-strip-types scripts/seo/suggest.ts --seeds "記念日 サプライズ,誕生日 サプライズ" --axis gift
 *   node --experimental-strip-types scripts/seo/suggest.ts --seeds "記念日 サプライズ" --axis gift --no-expand   # 種そのままだけ（速い）
 *   node --experimental-strip-types scripts/seo/suggest.ts --seeds "記念日 サプライズ" --axis gift --full        # 五十音46文字＋a-z（重い）
 *
 * 展開の深さ（1種KWあたりのリクエスト数）：
 *   既定（light） … 種KWそのまま ＋ 五十音の行頭10文字（あかさたなはまやらわ）＋ a-z = 37
 *   --full        … 種KWそのまま ＋ 五十音46文字 ＋ a-z                          = 73
 *   --no-expand   … 種KWそのままだけ                                              =  1
 * これに加えて、種KWの直下に出た候補（上限30件）を**もう1回だけ**種にして叩く（--no-expand では省く）。
 * demand.ts の「裾野」（その語の先にさらに検索が枝分かれしているか）の材料で、候補自身の需要の証拠になる。
 *
 * 出力：
 *   記事管理/KW候補/<日付>_<軸>.json          … KwCandidateFile。volume.ts が数字を足し、add-keywords.ts が D1 に入れる
 *   記事管理/KW候補/<日付>_<軸>.suggest.json  … SuggestRun（生データ）。demand.ts の入力で、式を変えたときの再計算用
 *   標準出力                                  … Markdown 表（需要スコア降順）
 *
 * 突合（D1 の台帳と記事。読むだけ）：
 *   既出   … normalizeKeyword が一致（表記ゆれ・同義語を吸う）。**候補から落とさず「既出」の印を付ける**。
 *            落とすと「なぜこのKWが出てこないのか」が追えない（爆速版は落としていたが、そこは変えた）
 *   カニバリ … src/lib/seo/cannibal.ts の dup / strong / weak。--axis があればその軸に絞る
 *
 * オプション：
 *   --seeds "<KW1>,<KW2>"   種KW（カンマ区切り。必須）
 *   --axis <slug>           軸（gift / date / concierge）。候補ファイルとカニバリ判定に使う
 *   --full / --no-expand    展開の深さ（上記）
 *   --local                 ローカル D1 と突合（既定は本番）
 *   --out <path>            候補ファイルの出力先（既定 記事管理/KW候補/<YYYY-MM-DD>_<axis>.json）
 *   --limit <n>             標準出力の表に出す上限（既定 40）
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FUNNELS, isAxisSlug, normalizeAxis, type AxisSlug, type Funnel } from '../../src/lib/axis.ts';
import { buildTargets, detectCannibal } from '../../src/lib/seo/cannibal.ts';
import { demandScores, suggestKey } from '../../src/lib/seo/demand.ts';
import { normalizeKeyword } from '../../src/lib/seo/tokens.ts';
import type { CannibalHit, KwCandidate, KwCandidateFile, SuggestQuery, SuggestRun } from '../../src/lib/seo/types.ts';
import { ROOT, die, loadSeoCatalog, takeCommonFlag } from './_d1.ts';

/* ────────────────────────────────────────────────
 * 設定
 * ──────────────────────────────────────────────── */

const ENDPOINT = 'https://www.google.com/complete/search';
/** Python 版と同じ UA。ブラウザ以外の UA だと空で返ることがある */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** リクエスト間のウェイト（ms）。詰めすぎると 429 で全部空になる */
const WAIT_MS = 400;
/** 候補自身を種にした再展開の上限 */
const REEXPAND_MAX = 30;

const GOJUON_HEADS = [...'あかさたなはまやらわ'];
const GOJUON_FULL = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'];
const ALPHABET = [...'abcdefghijklmnopqrstuvwxyz'];

const OUT_DIR = join(ROOT, '記事管理', 'KW候補');

/**
 * KW パターン → ファネル層の推定（keyword-selection.md 3章の表）。人が決める前の当たりで、
 * funnel 列には入れず note に「推定: 〜」と書くだけ。CV に近い層から当てる（同じ語が複数層に出たら課題解決を優先）。
 */
const FUNNEL_PATTERNS: ReadonlyArray<readonly [Funnel, readonly string[]]> = [
  ['課題解決', ['選び方', '失敗', '注意点', '伝え方', '頼み方', 'お願い', 'センスない', '選べない', '間に合わない', '忙しい', 'ネタ切れ', '嫌いな人']],
  ['比較・検討', ['比較', '違い', 'ランキング', 'おすすめ', 'プラン', '料金', 'サービス', 'どっち']],
  ['集客', ['とは', 'アイデア', '例', 'いつから', '何日前', 'タイミング', '相場', '予算', '飾り付け', 'メッセージ', '過ごし方']],
];

/* ────────────────────────────────────────────────
 * オプション
 * ──────────────────────────────────────────────── */

interface Options {
  seeds: string[];
  axis: AxisSlug | '';
  mode: 'light' | 'full' | 'none';
  local: boolean;
  out: string;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const local = takeCommonFlag(argv, '--local');
  const full = takeCommonFlag(argv, '--full');
  const noExpand = takeCommonFlag(argv, '--no-expand');
  const o: Options = { seeds: [], axis: '', mode: full ? 'full' : 'light', local, out: '', limit: 40 };
  if (noExpand) o.mode = 'none';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--seeds') {
      o.seeds = (argv[++i] ?? '')
        .split(/[,、]/)
        .map((s) => s.replace(/[\s　]+/g, ' ').trim())
        .filter(Boolean);
    } else if (a === '--axis') {
      const v = (argv[++i] ?? '').trim();
      const slug = isAxisSlug(v) ? v : normalizeAxis(v);
      if (!slug) die(`--axis は gift / date / concierge のどれか（渡されたのは「${v}」）`);
      o.axis = slug;
    } else if (a === '--out') o.out = (argv[++i] ?? '').trim();
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) die('--limit は正の整数');
      o.limit = n;
    } else die(`知らないオプション: ${a}`);
  }
  if (o.seeds.length === 0) die('--seeds が空（例: --seeds "記念日 サプライズ,誕生日 サプライズ"）');
  if (!o.out) o.out = join(OUT_DIR, `${today()}_${o.axis || 'all'}.json`);
  return o;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────
 * 補完API
 * ──────────────────────────────────────────────── */

/**
 * 1クエリぶんのサジェストを返す。失敗は空配列で続行（1つ落ちても全体を止めない）。
 * 応答は `[query, [suggestions...], ...]`。文字コードは Content-Type の charset → utf-8 → shift_jis の順で試す
 * （実測では utf-8 で返るが、Python 版の作法を残す）。
 */
async function fetchSuggestions(q: string): Promise<string[]> {
  const url = `${ENDPOINT}?${new URLSearchParams({ q, hl: 'ja', client: 'chrome' })}`;
  let bytes: Uint8Array;
  let ct = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`    [取得失敗] ${q}: HTTP ${res.status}`);
      return [];
    }
    ct = res.headers.get('content-type') ?? '';
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.error(`    [取得失敗] ${q}: ${(e as Error).message}`);
    return [];
  }
  const m = ct.match(/charset=([\w-]+)/i);
  const encodings = [...(m ? [m[1]!] : []), 'utf-8', 'shift_jis', 'euc-jp'];
  for (const enc of encodings) {
    try {
      const data = JSON.parse(new TextDecoder(enc).decode(bytes));
      if (Array.isArray(data) && Array.isArray(data[1])) {
        return (data[1] as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '');
      }
    } catch {
      /* 次の文字コードで試す */
    }
  }
  return [];
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2));

const suffixes = opts.mode === 'none' ? [] : opts.mode === 'full' ? [...GOJUON_FULL, ...ALPHABET] : [...GOJUON_HEADS, ...ALPHABET];
const modeLabel = opts.mode === 'none' ? 'none（種そのままだけ）' : opts.mode === 'full' ? 'full（五十音46＋a-z）' : 'light（あかさたなはまやらわ＋a-z）';
console.log(`種KW ${opts.seeds.length} 件 × ${1 + suffixes.length} パターン（${modeLabel}）`);

/* ── 展開 ── */
const queries: SuggestQuery[] = [];
/** 候補 → どの種KW（クラスタ）の展開で出たか。最初に見た方を採る */
const clusterOf = new Map<string, string>();
const seedKeys = new Set(opts.seeds.map(suggestKey));
/** 再展開の対象（種KWの直下に出た候補）。出た順 */
const direct: string[] = [];

function record(q: SuggestQuery, cluster: string): void {
  queries.push(q);
  for (const s of q.results) {
    const k = suggestKey(s);
    if (k && !clusterOf.has(k)) clusterOf.set(k, cluster);
  }
}

for (const seed of opts.seeds) {
  const before = clusterOf.size;
  const top = await fetchSuggestions(seed);
  record({ q: seed, kind: 'seed', seed, results: top }, seed);
  for (const s of top) {
    const k = suggestKey(s);
    if (k && !seedKeys.has(k) && !direct.some((d) => suggestKey(d) === k)) direct.push(s.replace(/[\s　]+/g, ' ').trim());
  }
  await sleep(WAIT_MS);
  for (const suf of suffixes) {
    const q = `${seed} ${suf}`;
    record({ q, kind: 'expand', seed, results: await fetchSuggestions(q) }, seed);
    await sleep(WAIT_MS);
  }
  console.log(`  ${seed} … ${clusterOf.size - before} 件`);
}

/*
 * 再展開。種KWの直下に出た候補を1回だけ種にして叩く。kind='seed' で seed=候補 にするのは
 * demand.ts が「run に seed=候補 のクエリがあるか」で裾野を数えるため。クラスタ（KwCandidate.seed）は
 * 元の種KWのままにして、派生の派生も同じクラスタに束ねる。
 */
let reexpanded = 0;
if (opts.mode !== 'none' && direct.length > 0) {
  const targets = direct.slice(0, REEXPAND_MAX);
  console.log(`再展開: 種KW直下の候補 ${targets.length} 件（上限 ${REEXPAND_MAX}）`);
  for (const cand of targets) {
    record({ q: cand, kind: 'seed', seed: cand, results: await fetchSuggestions(cand) }, clusterOf.get(suggestKey(cand)) ?? cand);
    reexpanded++;
    await sleep(WAIT_MS);
  }
}
const run: SuggestRun = { queries };
console.log(`リクエスト ${queries.length} 件（うち再展開 ${reexpanded}）`);

/* ── 生データを残す（式を変えたときの再計算用） ── */
const outPath = resolve(opts.out);
const runPath = outPath.replace(/\.json$/i, '') + '.suggest.json';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf8');

/* ── 需要スコア ── */
const scored = demandScores(run);
if (scored.length === 0) die('サジェストが1件も取れなかった（補完APIが空を返している。時間をおいて再実行）');

/* ── 台帳・記事と突合 ── */
const catalog = loadSeoCatalog({ local: opts.local });
/*
 * 既出の判定。記事の keyword を先に見る——台帳にも記事にもあるKWは「記事がある」の方が状況として強い
 * （台帳にあるだけなら、これから書く予定＝候補に上げ直す意味はまだある）。
 */
const knownArticle = new Map<string, string>();
for (const a of catalog.articles) {
  const k = normalizeKeyword(a.keyword);
  if (k && !knownArticle.has(k)) knownArticle.set(k, a.slug || a.title);
}
const knownKeyword = new Map<string, string>();
for (const k of catalog.keywords) {
  const n = normalizeKeyword(k.keyword);
  if (n && !knownKeyword.has(n)) knownKeyword.set(n, k.status);
}
const targets = buildTargets(catalog.keywords, catalog.articles);
console.log(`突合: ${opts.local ? 'ローカル' : '本番'} D1（台帳 ${catalog.keywords.length} 件・記事 ${catalog.articles.length} 件）`);

function guessFunnel(keyword: string): Funnel | '' {
  const s = keyword.normalize('NFKC');
  for (const [funnel, words] of FUNNEL_PATTERNS) {
    if (words.some((w) => s.includes(w))) return funnel;
  }
  return '';
}

const LEVEL_ORDER = { dup: 0, strong: 1, weak: 2 } as const;
function strongest(hits: CannibalHit[]): CannibalHit | undefined {
  return [...hits].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.score - a.score)[0];
}

const candidates: KwCandidate[] = scored.map((d) => {
  const n = normalizeKeyword(d.keyword);
  const known: KwCandidate['known'] = knownArticle.has(n) ? 'article' : knownKeyword.has(n) ? 'keyword' : null;
  const guess = guessFunnel(d.keyword);
  return {
    keyword: d.keyword,
    seed: clusterOf.get(suggestKey(d.keyword)) ?? '',
    axis: opts.axis,
    funnel: '',
    demand: d.score,
    volume: null,
    volumeSource: null,
    kd: null,
    gscImpr: null,
    known,
    cannibal: detectCannibal(d.keyword, targets, opts.axis ? { axis: opts.axis } : undefined),
    hits: d.hits,
    serpGrade: '',
    serpNote: '',
    verdict: '',
    note: guess ? `推定: ${guess}` : '',
  };
});

/* ── 候補ファイル ── */
const file: KwCandidateFile = { generated_at: new Date().toISOString(), axis: opts.axis, seeds: opts.seeds, candidates };
if (existsSync(outPath)) copyFileSync(outPath, `${outPath}.bak`);
writeFileSync(outPath, JSON.stringify(file, null, 2), 'utf8');

/* ── 表 ── */
const knownCount = candidates.filter((c) => c.known).length;
const fresh = candidates.filter((c) => !c.known);
const dupCount = fresh.filter((c) => strongest(c.cannibal)?.level === 'dup').length;
const strongCount = fresh.filter((c) => strongest(c.cannibal)?.level === 'strong').length;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
console.log('');
console.log(
  `種KW: ${opts.seeds.join('・')} ／ 展開: ${modeLabel} ／ リクエスト ${queries.length} 件 ／ ` +
    `候補 ${candidates.length} 件（うち既出 ${knownCount}・既出以外で dup ${dupCount}・strong ${strongCount}）`,
);
console.log('');
console.log('| # | KW | 需要 | 既出 | カニバリ | 根拠 |');
console.log('|--:|---|--:|---|---|---|');
candidates.slice(0, opts.limit).forEach((c, i) => {
  const n = normalizeKeyword(c.keyword);
  const known = c.known === 'article' ? `既出（記事 ${knownArticle.get(n) ?? ''}）` : c.known === 'keyword' ? `既出（台帳 ${knownKeyword.get(n) ?? ''}）` : '';
  const top = strongest(c.cannibal);
  const cannibal = top ? `${top.level}: ${top.against.keyword}${c.cannibal.length > 1 ? `（+${c.cannibal.length - 1}）` : ''}` : '';
  const why = c.hits.slice(0, 3).join('、') + (c.hits.length > 3 ? ` 他${c.hits.length - 3}` : '');
  console.log(`| ${i + 1} | ${cell(c.keyword)} | ${c.demand} | ${cell(known)} | ${cell(cannibal)} | ${cell(why)} |`);
});
if (candidates.length > opts.limit) console.log(`\n（残り ${candidates.length - opts.limit} 件は ${outPath} を見る）`);
console.log('');
console.log(`候補ファイル: ${outPath}`);
console.log(`生データ    : ${runPath}`);
console.log(`\n次のステップ：\`scripts/seo/volume.ts ${opts.out}\` でボリュームを付ける（--ahrefs / --csv / --gsc）。funnel は人が決める（${FUNNELS.join(' / ')}）`);
