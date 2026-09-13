/**
 * 候補ファイルの verdict が win / hold の候補を D1 の台帳（keywords）に入れる。/anniv-pick-keyword の最後の工程（Step 6）。
 * 候補ファイルは suggest.ts が作り、volume.ts が数字を足し、Claude が serpGrade / verdict / funnel / note を書いたもの。
 *
 *   node --experimental-strip-types scripts/seo/add-keywords.ts 記事管理/KW候補/2026-09-10_gift.json --dry-run   # 入れる行を表で見るだけ
 *   node --experimental-strip-types scripts/seo/add-keywords.ts 記事管理/KW候補/2026-09-10_gift.json             # 本番 D1 に入れる
 *   node --experimental-strip-types scripts/seo/add-keywords.ts 記事管理/KW候補/2026-09-10_gift.json --local     # ローカル D1（astro dev 用）
 *
 * 入れるもの・入れないもの（keyword-selection.md 6章）：
 *   win        … status=todo, priority=2
 *   hold       … status=todo, priority=3（note に保留理由が入っている前提）
 *   drop / '' … 入れない（drop は候補ファイルに理由を残すだけ。'' は判定がまだ）
 *   既出       … 台帳か記事に同じKW（normalizeKeyword 一致）があればスキップして知らせる。
 *                優先度や note を勝手に上書きしない（直したいときは /admin/keywords/<id> で）
 *
 * funnel が空の win / hold が1件でもあれば、何も入れずに止まる（keyword-selection.md 3章で決めてから流す。
 * SKILL の Step 5 で Claude が書き込む前提。途中で止まって半分だけ入るのを避けるため、検査は先に全件やる）。
 *
 * 列の埋め方：
 *   difficulty … serpGrade から（A=高 / B=中 / C=低。空なら 中）   volume … 実数から（<100 小 / <1000 中 / それ以上 大。無ければ 中）
 *   note       … 候補の note ＋「／SERP: …」＋「／カニバリ注意: <相手> (<理由>)」（2000字で切る）
 *   researched_at … 今日（JST）。intent / persona は空で入れる（記事を書くときに埋める）
 *
 * **台帳の CSV（記事管理/KWマスターDB.csv）は手で書かない**。D1 から吐き出す派生物で、/anniv-update-pv か
 * 管理画面の CSV エクスポートで更新される。
 *
 * D1 は wrangler（ユーザーの Cloudflare ログイン）で直接叩く（_d1.ts）。1件1文の INSERT … ON CONFLICT(keyword) DO UPDATE を
 * lit() で組み、d1Many でまとめて1回流す（wrangler の起動は1回3〜5秒）。ON CONFLICT 側は src/lib/db.ts の upsertKeyword と
 * 同じ列を更新する——既出はスキップ済みなので実質 INSERT だが、万一ぶつかっても空で渡した SEO 列は既存値を残す。
 *
 * オプション：
 *   --dry-run   SQL を流さず、入れる行の表を出す
 *   --local     ローカルの D1（astro dev 用）。既定は本番
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FUNNELS, isAxisSlug, isFunnel } from '../../src/lib/axis.ts';
import { gradeToDifficulty } from '../../src/lib/seo/serp.ts';
import { normalizeKeyword } from '../../src/lib/seo/tokens.ts';
import type { KwCandidate, KwCandidateFile, SeoArticle, SeoKeyword } from '../../src/lib/seo/types.ts';
import { d1Many, die, lit, loadSeoCatalog, takeCommonFlag } from './_d1.ts';

/** note 列に入れる上限（台帳の表示が崩れない程度） */
const NOTE_MAX = 2000;
/** keyword-selection.md 6章：勝ち筋は 2、保留は 3（1 は人が付ける最優先） */
const PRIORITY: Record<'win' | 'hold', number> = { win: 2, hold: 3 };

/* ────────────────────────────────────────────────
 * オプション
 * ──────────────────────────────────────────────── */

interface Options {
  file: string;
  dryRun: boolean;
  local: boolean;
}

function parseArgs(argv: string[]): Options {
  const local = takeCommonFlag(argv, '--local');
  const dryRun = takeCommonFlag(argv, '--dry-run');
  const o: Options = { file: '', dryRun, local };
  for (const a of argv) {
    if (!a.startsWith('--') && !o.file) o.file = a;
    else die(`知らないオプション: ${a}`);
  }
  if (!o.file) die('候補ファイルのパスを渡すこと（例: scripts/seo/add-keywords.ts 記事管理/KW候補/2026-09-10_gift.json --dry-run）');
  return o;
}

/** 今日（JST）。researched_at は「調べた日」なので、UTC で日付が変わる深夜に流しても日本の日付にする */
function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ────────────────────────────────────────────────
 * 列の組み立て
 * ──────────────────────────────────────────────── */

/** 台帳の volume 列（人が読む粗い目安）。実数は volume_num に別で入る */
function volumeBucket(v: number | null): '小' | '中' | '大' {
  if (v === null) return '中';
  return v < 100 ? '小' : v < 1000 ? '中' : '大';
}

/**
 * note 列。候補の note（win なら差別化の芯、hold なら保留理由）を先頭に、SERP の根拠とカニバリの相手を後ろに足す。
 * dup は Step 2 で drop になっているはずなので載せない。strong は hold の「切り口をずらせるか未検討」の材料なので印を付けて残す。
 */
function buildNote(c: KwCandidate): string {
  const parts = [c.note.trim()];
  if (c.serpNote.trim()) parts.push(`SERP: ${c.serpNote.trim()}`);
  for (const h of c.cannibal) {
    if (h.level === 'dup') continue;
    const who = h.against.kind === 'article' && h.against.slug ? `${h.against.keyword}（記事 ${h.against.slug}）` : h.against.keyword;
    parts.push(`カニバリ注意${h.level === 'strong' ? '(strong)' : ''}: ${who} (${h.reason})`);
  }
  const note = parts.filter(Boolean).join('／').replace(/\r\n?/g, '\n');
  return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX) : note;
}

/** keywords テーブルに入れる1行（db.ts の KeywordInput と同じ列。intent / persona / article_id は固定） */
interface Row {
  verdict: 'win' | 'hold';
  keyword: string;
  axis: string;
  funnel: string;
  difficulty: string;
  volume: string;
  priority: number;
  note: string;
  seed: string;
  volume_num: number | null;
  volume_source: string;
  demand_score: number | null;
  kd: number | null;
  serp_grade: string;
  serp_note: string;
  researched_at: string;
}

function toRow(c: KwCandidate, axis: string, researchedAt: string): Row {
  const verdict = c.verdict as 'win' | 'hold';
  return {
    verdict,
    keyword: c.keyword.replace(/[\s　]+/g, ' ').trim(),
    axis,
    funnel: c.funnel,
    difficulty: gradeToDifficulty(c.serpGrade) || '中',
    volume: volumeBucket(c.volume),
    priority: PRIORITY[verdict],
    note: buildNote(c),
    seed: c.seed.trim(),
    volume_num: c.volume,
    volume_source: c.volumeSource ?? '',
    demand_score: c.demand,
    kd: c.kd,
    serp_grade: c.serpGrade,
    serp_note: c.serpNote.trim(),
    researched_at: researchedAt,
  };
}

/**
 * db.ts の upsertKeyword と同じ INSERT … ON CONFLICT。bind が使えないので lit() で埋める。
 * upsertKeyword は「渡されなかった（undefined）SEO 列は既存値を残す」。ここでは空文字で渡す列を
 * その扱いにする（seed / volume_source / serp_grade / serp_note が空＝まだ調べていない、なので潰さない）。
 * 数値列は COALESCE、researched_at は今日を必ず入れる。
 */
function upsertSql(r: Row, now: string): string {
  const keep = (col: 'seed' | 'volume_source' | 'serp_grade' | 'serp_note') => (r[col] === '' ? `keywords.${col}` : `excluded.${col}`);
  return `INSERT INTO keywords
  (keyword,axis,funnel,intent,persona,difficulty,volume,priority,status,article_id,note,
   seed,volume_num,volume_source,demand_score,kd,serp_grade,serp_note,researched_at,created_at,updated_at)
  VALUES (${lit(r.keyword)},${lit(r.axis)},${lit(r.funnel)},'','',${lit(r.difficulty)},${lit(r.volume)},${r.priority},'todo',NULL,${lit(r.note)},
   ${lit(r.seed)},${lit(r.volume_num)},${lit(r.volume_source)},${lit(r.demand_score)},${lit(r.kd)},${lit(r.serp_grade)},${lit(r.serp_note)},${lit(r.researched_at)},${lit(now)},${lit(now)})
  ON CONFLICT(keyword) DO UPDATE SET
    axis=excluded.axis, funnel=excluded.funnel, intent=excluded.intent,
    persona=excluded.persona, difficulty=excluded.difficulty, volume=excluded.volume,
    priority=excluded.priority, note=excluded.note,
    seed=${keep('seed')},
    volume_num=COALESCE(excluded.volume_num, keywords.volume_num),
    volume_source=${keep('volume_source')},
    demand_score=COALESCE(excluded.demand_score, keywords.demand_score),
    kd=COALESCE(excluded.kd, keywords.kd),
    serp_grade=${keep('serp_grade')},
    serp_note=${keep('serp_note')},
    researched_at=excluded.researched_at,
    updated_at=excluded.updated_at`;
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2));
const filePath = resolve(opts.file);
if (!existsSync(filePath)) die(`候補ファイルが無い: ${filePath}`);
let file: KwCandidateFile;
try {
  file = JSON.parse(readFileSync(filePath, 'utf8')) as KwCandidateFile;
} catch (e) {
  die(`候補ファイルを読めない: ${(e as Error).message}`);
}
if (!Array.isArray(file.candidates)) die('候補ファイルの形が違う（candidates が配列でない）');

/* ── 入れる前の検査（全件。途中で止まって半分だけ入るのを避ける） ── */
const picked = file.candidates.filter((c) => c.verdict === 'win' || c.verdict === 'hold');
const axisOf = (c: KwCandidate): string => c.axis || file.axis || '';

const noFunnel = picked.filter((c) => !c.funnel);
if (noFunnel.length) {
  die(
    `funnel が空の win / hold が ${noFunnel.length} 件ある: ${noFunnel.map((c) => c.keyword).join('、')}\n` +
      `  funnel を決めてから流す（keyword-selection.md 3章。${FUNNELS.join(' / ')} のどれか）`,
  );
}
const badFunnel = picked.filter((c) => !isFunnel(c.funnel));
if (badFunnel.length) {
  die(`funnel の値が違う（${FUNNELS.join(' / ')} のどれか）: ${badFunnel.map((c) => `${c.keyword}=「${c.funnel}」`).join('、')}`);
}
const badAxis = picked.filter((c) => !isAxisSlug(axisOf(c)));
if (badAxis.length) {
  die(`axis が空か不正な win / hold が ${badAxis.length} 件ある（gift / date / concierge）: ${badAxis.map((c) => `${c.keyword}=「${axisOf(c)}」`).join('、')}`);
}

/* ── 台帳・記事と突合（候補ファイルの known は作った時点の情報なので、今の D1 で引き直す） ── */
const catalog = loadSeoCatalog({ local: opts.local });
console.log(`突合: ${opts.local ? 'ローカル' : '本番'} D1（台帳 ${catalog.keywords.length} 件・記事 ${catalog.articles.length} 件）`);

/** 表記そのまま（e:）と normalizeKeyword（n:）の両方で引けるようにする。最初に見た行を採る */
function keysOf(keyword: string): string[] {
  const exact = keyword.replace(/[\s　]+/g, ' ').trim();
  const n = normalizeKeyword(keyword);
  return [exact ? `e:${exact}` : '', n ? `n:${n}` : ''].filter(Boolean);
}
const ledger = new Map<string, SeoKeyword>();
for (const k of catalog.keywords) for (const key of keysOf(k.keyword)) if (!ledger.has(key)) ledger.set(key, k);
const published = new Map<string, SeoArticle>();
for (const a of catalog.articles) for (const key of keysOf(a.keyword)) if (!published.has(key)) published.set(key, a);
const lookup = <T>(map: Map<string, T>, keyword: string): T | undefined => {
  for (const key of keysOf(keyword)) {
    const hit = map.get(key);
    if (hit) return hit;
  }
  return undefined;
};

/* ── 振り分け ── */
interface Skip {
  keyword: string;
  reason: string;
}
const rows: Row[] = [];
const skipped: Skip[] = [];
/** 同じ候補ファイルの中で normalizeKeyword が同じ候補（同義語で寄る）。先に来た方だけ入れる */
const seenInFile = new Map<string, string>();
const researchedAt = todayJst();

for (const c of file.candidates) {
  if (c.verdict === 'drop') {
    skipped.push({ keyword: c.keyword, reason: `drop${c.note ? `（${c.note}）` : ''}` });
    continue;
  }
  if (c.verdict !== 'win' && c.verdict !== 'hold') {
    skipped.push({ keyword: c.keyword, reason: 'verdict 空（判定がまだ）' });
    continue;
  }
  const inLedger = lookup(ledger, c.keyword);
  if (inLedger) {
    skipped.push({ keyword: c.keyword, reason: `既出（台帳 #${inLedger.id}「${inLedger.keyword}」${inLedger.status}）` });
    continue;
  }
  const inArticles = lookup(published, c.keyword);
  if (inArticles) {
    skipped.push({ keyword: c.keyword, reason: `既出（記事 ${inArticles.slug || inArticles.title}・${inArticles.status}）` });
    continue;
  }
  if (c.known) {
    // 候補ファイルは既出と言っているが今の D1 には無い（台帳から消した等）。入れずに知らせる——判断は人がする
    skipped.push({ keyword: c.keyword, reason: `既出（候補ファイルの known=${c.known}。今の D1 には無いので確認してから）` });
    continue;
  }
  const n = normalizeKeyword(c.keyword) || c.keyword.trim();
  const first = seenInFile.get(n);
  if (first) {
    skipped.push({ keyword: c.keyword, reason: `候補ファイル内で重複（「${first}」と同じKW）` });
    continue;
  }
  seenInFile.set(n, c.keyword);
  rows.push(toRow(c, axisOf(c), researchedAt));
}

/* ── 表（dry-run はここまで） ── */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
console.log('');
console.log(`候補ファイル: ${filePath}（${file.candidates.length} 件。win ${picked.filter((c) => c.verdict === 'win').length}・hold ${picked.filter((c) => c.verdict === 'hold').length}）`);
console.log('');
if (rows.length) {
  console.log('| # | KW | 軸 | ファネル | 判定 | 優先度 | 難易度 | 要塞度 | 検索数 | 需要 | seed |');
  console.log('|--:|---|---|---|---|--:|---|---|--:|--:|---|');
  rows.forEach((r, i) => {
    const vol = r.volume_num === null ? `—（${r.volume}）` : `${r.volume_num}${r.volume_source ? ` ${r.volume_source}` : ''}（${r.volume}）`;
    console.log(
      `| ${i + 1} | ${cell(r.keyword)} | ${r.axis} | ${r.funnel} | ${r.verdict} | ${r.priority} | ${r.difficulty} | ${r.serp_grade || '—'} | ${vol} | ${r.demand_score ?? '—'} | ${cell(r.seed) || '—'} |`,
    );
  });
} else {
  console.log('入れる行が無い（win / hold の候補が無いか、全部既出）');
}
if (skipped.length) {
  console.log('');
  console.log(`スキップ ${skipped.length} 件:`);
  for (const s of skipped) console.log(`  - ${s.keyword} … ${s.reason}`);
}

if (opts.dryRun) {
  console.log('');
  console.log(`dry-run: D1 には入れていない（追加予定 ${rows.length} 件／スキップ ${skipped.length} 件）。--dry-run を外して本実行`);
  process.exit(0);
}

/* ── D1 に入れる（まとめて1回） ── */
if (rows.length) {
  const now = new Date().toISOString();
  d1Many(
    rows.map((r) => upsertSql(r, now)),
    { local: opts.local },
  );
}

console.log('');
console.log(`追加 ${rows.length} 件／スキップ ${skipped.length} 件（${opts.local ? 'ローカル' : '本番'} D1 の keywords。researched_at=${researchedAt}）`);
console.log('台帳の CSV（記事管理/KWマスターDB.csv）は手で書かない。/anniv-update-pv か管理画面の CSV エクスポートで派生する');

const wins = rows.filter((r) => r.verdict === 'win');
console.log('');
if (wins.length) {
  console.log(`次：\`/anniv-write-article ${wins[0]!.keyword}\`${wins.length > 1 ? `（他の勝ち筋: ${wins.slice(1).map((r) => r.keyword).join('、')}）` : ''}`);
} else {
  console.log('次：`/anniv-write-article <KW>`（この回は win が無い。hold は /admin/keywords で寝かせておく）');
}
