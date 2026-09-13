/**
 * 候補ファイル（suggest.ts の出力）に検索ボリュームの実数を付ける。/anniv-pick-keyword の2番目の工程。
 *
 *   node --experimental-strip-types scripts/seo/volume.ts 記事管理/KW候補/2026-09-10_gift.json --ahrefs ahrefs.json
 *   node --experimental-strip-types scripts/seo/volume.ts 記事管理/KW候補/2026-09-10_gift.json --csv 記事管理/ボリューム/keyword-planner.csv
 *   node --experimental-strip-types scripts/seo/volume.ts 記事管理/KW候補/2026-09-10_gift.json --gsc
 *   （3つは同時に渡してもよい。順に ahrefs → csv → gsc で当てる）
 *
 * ソースの優先順位は keyword-selection.md 4章：ahrefs ＞ csv ＞ gsc。
 * **上位のソースが既に入っている候補は、下位のソースで上書きしない**（--csv を流しても Ahrefs の値は残る）。
 * 同じか上位のソースなら上書きする（Ahrefs を取り直したら新しい値が勝つ）。
 *
 * 突合は normalizeKeyword の一致（表記ゆれ・同義語を吸う。「記念日 ギフト」と「記念日 プレゼント」は同じ扱い）。
 *
 * オプション：
 *   --ahrefs <json>  Ahrefs MCP で取った値。{"<keyword>": {"volume": 1200, "kd": 12}, ...}
 *                    （[{"keyword": ..., "volume": ..., "kd": ...}] の配列でも読む）
 *   --csv <path>     キーワードプランナー／ラッコの CSV（src/lib/seo/volume.ts でパース。UTF-16／タブ区切りも可）
 *   --gsc            記事管理/KW候補/gsc-queries.json（{query, impressions, clicks, position}[]）があれば表示数を付ける。
 *                    無ければ1行出して飛ばす（ファイルを書くのは update-pv.ts 側。ローカルに鍵が無いと作れない）
 *   --local          他のスクリプトと同じ形で受けるだけ（このスクリプトは D1 を読まない）
 *
 * 候補ファイルは in-place で更新する（元は .bak に残す）。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeKeyword } from '../../src/lib/seo/tokens.ts';
import type { KwCandidate, KwCandidateFile, VolumeSource } from '../../src/lib/seo/types.ts';
import { decodeCsvBytes, parseVolumeCsv } from '../../src/lib/seo/volume.ts';
import { ROOT, die, takeCommonFlag } from './_d1.ts';

const GSC_PATH = join(ROOT, '記事管理', 'KW候補', 'gsc-queries.json');

/** 小さいほど信頼できる（keyword-selection.md 4章） */
const RANK: Record<Exclude<VolumeSource, null>, number> = { ahrefs: 1, csv: 2, gsc: 3 };

interface Options {
  file: string;
  ahrefs: string;
  csv: string;
  gsc: boolean;
}

function parseArgs(argv: string[]): Options {
  takeCommonFlag(argv, '--local');
  const gsc = takeCommonFlag(argv, '--gsc');
  const o: Options = { file: '', ahrefs: '', csv: '', gsc };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--ahrefs') o.ahrefs = (argv[++i] ?? '').trim();
    else if (a === '--csv') o.csv = (argv[++i] ?? '').trim();
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else die(`知らないオプション: ${a}`);
  }
  if (!o.file) die('候補ファイルのパスを渡すこと（例: scripts/seo/volume.ts 記事管理/KW候補/2026-09-10_gift.json --csv x.csv）');
  if (!o.ahrefs && !o.csv && !o.gsc) die('--ahrefs / --csv / --gsc のどれか1つは要る');
  return o;
}

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

/** normalizeKeyword → 候補。同義語で寄ると複数の候補が同じキーになるので配列 */
const index = new Map<string, KwCandidate[]>();
for (const c of file.candidates) {
  const k = normalizeKeyword(c.keyword);
  if (!k) continue;
  const list = index.get(k);
  if (list) list.push(c);
  else index.set(k, [c]);
}

/** 今のソースより上位か同位のソースなら上書きしてよい */
function canOverwrite(current: VolumeSource, incoming: Exclude<VolumeSource, null>): boolean {
  return current === null || RANK[incoming] <= RANK[current];
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

interface ApplyResult {
  /** 入力側の件数 */
  input: number;
  /** 候補に当たった入力の件数 */
  matched: number;
  /** 値を書き換えた候補の数 */
  updated: number;
  /** 上位ソースが既にあって据え置いた候補の数 */
  kept: number;
}

/* ── Ahrefs ── */
function applyAhrefs(path: string): ApplyResult {
  const p = resolve(path);
  if (!existsSync(p)) die(`--ahrefs のファイルが無い: ${p}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    die(`--ahrefs の JSON を読めない: ${(e as Error).message}`);
  }
  // {"kw": {...}} でも [{"keyword": "kw", ...}] でも受ける（MCP の出力をそのまま貼ることが多いため）
  const entries: Array<[string, { volume?: unknown; kd?: unknown }]> = Array.isArray(raw)
    ? (raw as any[]).map((r) => [String(r.keyword ?? r.kw ?? ''), r])
    : Object.entries(raw as Record<string, any>);
  const r: ApplyResult = { input: entries.length, matched: 0, updated: 0, kept: 0 };
  for (const [keyword, v] of entries) {
    const hits = index.get(normalizeKeyword(keyword));
    if (!hits) continue;
    r.matched++;
    for (const c of hits) {
      if (!canOverwrite(c.volumeSource, 'ahrefs')) {
        r.kept++;
        continue;
      }
      c.volume = toNumber(v?.volume);
      c.kd = toNumber(v?.kd);
      c.volumeSource = 'ahrefs';
      r.updated++;
    }
  }
  return r;
}

/* ── 手動 CSV ── */
function applyCsv(path: string): ApplyResult {
  const p = resolve(path);
  if (!existsSync(p)) die(`--csv のファイルが無い: ${p}`);
  const parsed = parseVolumeCsv(decodeCsvBytes(new Uint8Array(readFileSync(p))));
  if ('error' in parsed) die(`CSV を読めない: ${parsed.error}`);
  console.log(`  CSV の列: KW=「${parsed.keywordCol}」 検索数=「${parsed.volumeCol}」（${parsed.rows.length} 行）`);
  const r: ApplyResult = { input: parsed.rows.length, matched: 0, updated: 0, kept: 0 };
  for (const row of parsed.rows) {
    if (row.volume === null) continue;
    const hits = index.get(normalizeKeyword(row.keyword));
    if (!hits) continue;
    r.matched++;
    for (const c of hits) {
      if (!canOverwrite(c.volumeSource, 'csv')) {
        r.kept++;
        continue;
      }
      c.volume = row.volume;
      c.volumeSource = 'csv';
      // CSV の「競合性」は Ahrefs の KD とは別の指標。KD が空のときの代用としてだけ入れ、Ahrefs の値は潰さない
      if (row.kd !== null && c.kd === null) c.kd = row.kd;
      r.updated++;
    }
  }
  return r;
}

/* ── Search Console ── */
function applyGsc(): ApplyResult | null {
  if (!existsSync(GSC_PATH)) {
    console.log(`  GSC データが無い（${GSC_PATH}）。update-pv.ts が書くファイルで、鍵が無い環境では作れない。飛ばす`);
    return null;
  }
  let rows: Array<{ query?: string; impressions?: unknown; clicks?: unknown; position?: unknown }>;
  try {
    rows = JSON.parse(readFileSync(GSC_PATH, 'utf8'));
  } catch (e) {
    die(`gsc-queries.json を読めない: ${(e as Error).message}`);
  }
  if (!Array.isArray(rows)) die('gsc-queries.json の形が違う（配列でない）');
  const r: ApplyResult = { input: rows.length, matched: 0, updated: 0, kept: 0 };
  for (const row of rows) {
    const impr = toNumber(row.impressions);
    if (!row.query || impr === null) continue;
    const hits = index.get(normalizeKeyword(row.query));
    if (!hits) continue;
    r.matched++;
    for (const c of hits) {
      // 表示数は別列なので常に入れる（同じ候補に複数クエリが当たったら大きい方）
      c.gscImpr = Math.max(c.gscImpr ?? 0, impr);
      if (!canOverwrite(c.volumeSource, 'gsc')) {
        r.kept++;
        continue;
      }
      c.volume = impr;
      c.volumeSource = 'gsc';
      r.updated++;
    }
  }
  return r;
}

const line = (name: string, r: ApplyResult) =>
  console.log(`  ${name}: 入力 ${r.input} 件 → 候補に当たった ${r.matched} 件（更新 ${r.updated}・上位ソースがあるので据え置き ${r.kept}）`);

console.log(`候補ファイル: ${filePath}（${file.candidates.length} 件）`);
if (opts.ahrefs) line('Ahrefs', applyAhrefs(opts.ahrefs));
if (opts.csv) line('CSV', applyCsv(opts.csv));
if (opts.gsc) {
  const r = applyGsc();
  if (r) line('GSC', r);
}

/* ── 書き戻し ── */
copyFileSync(filePath, `${filePath}.bak`);
writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');

/* ── 表 ── */
const withVolume = file.candidates.filter((c) => c.volume !== null);
const without = file.candidates.filter((c) => c.volume === null);
const sorted = [...file.candidates].sort(
  (a, b) => (b.volume ?? -1) - (a.volume ?? -1) || (b.demand ?? -1) - (a.demand ?? -1) || a.keyword.localeCompare(b.keyword, 'ja'),
);
const cell = (s: string) => s.replace(/\|/g, '\\|');
console.log('');
console.log(`ボリューム付き ${withVolume.length} 件 ／ 付かなかった ${without.length} 件`);
console.log('');
console.log('| # | KW | 需要 | 検索数 | KD | ソース | GSC表示 |');
console.log('|--:|---|--:|--:|--:|---|--:|');
sorted.forEach((c, i) => {
  console.log(
    `| ${i + 1} | ${cell(c.keyword)}${c.known ? '（既出）' : ''} | ${c.demand ?? ''} | ${c.volume ?? ''} | ${c.kd ?? ''} | ${c.volumeSource ?? ''} | ${c.gscImpr ?? ''} |`,
  );
});
if (without.length) {
  console.log('');
  console.log(`付かなかった候補（${without.length} 件）: ${without.map((c) => c.keyword).join('、')}`);
}
console.log('');
console.log(`更新した: ${filePath}（元は .bak）`);
console.log('次のステップ：SERP 要塞度（serpGrade）と verdict を候補ファイルに書き、`scripts/seo/add-keywords.ts` で台帳に入れる');
