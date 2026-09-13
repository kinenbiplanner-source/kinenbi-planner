/**
 * 内部リンクの提案を D1 の記事から出す（src/lib/seo/internal-links.ts の CLI）。
 *
 *   node --experimental-strip-types scripts/seo/links.ts --kw "記念日 サプライズ 自宅" --axis gift   # これから書くKW：既存記事のどこから張れるか
 *   node --experimental-strip-types scripts/seo/links.ts --slug whenrestaurantappointment           # この記事へ／この記事から
 *   node --experimental-strip-types scripts/seo/links.ts --orphans                                  # 孤立記事（誰からもリンクされていない公開記事）
 *   node --experimental-strip-types scripts/seo/links.ts --all                                      # 全提案（上位50）
 *
 * 出力は Markdown の表。/anniv-write-article が「内部リンク指定」（style-guide 11章）を組むときに
 * そのまま読める形にしてある。表の下に、to ごとに差し込み文の例を1つ出す。
 *
 * D1 は wrangler（ユーザーの Cloudflare ログイン）で直接読む（_d1.ts）。読むだけで書かない。
 *
 * オプション：
 *   --kw <KW>        これから書くKW。--axis と組で使う
 *   --axis <slug>    gift / date / concierge（--kw の軸。重み付けに使う。省略すると中立）
 *   --slug <slug>    既存記事1本を軸に「へ」「から」の両方を出す
 *   --orphans        孤立記事と、そこへ張れる候補（各3件）
 *   --all            公開記事どうしの全提案
 *   --limit <n>      提案の上限（既定 50）
 *   --min <score>    足切りスコア（既定 0.5）
 *   --local          ローカルの D1（astro dev 用）。既定は本番
 *   --json <path>    結果を JSON でも書く
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_LIMIT,
  DEFAULT_MIN_SCORE,
  MIN_COVERAGE,
  REVERSE_AXIS_WEIGHT,
  buildLinkGraph,
  findOrphans,
  linkCounts,
  suggestLinks,
  suggestLinksForKeyword,
} from '../../src/lib/seo/internal-links.ts';
import type { LinkSuggestion, SeoArticle } from '../../src/lib/seo/types.ts';
import { axisShort, isAxisSlug } from '../../src/lib/axis.ts';
import { die, loadSeoCatalog, takeCommonFlag } from './_d1.ts';

/* ────────────────────────────────────────────────
 * オプション
 * ──────────────────────────────────────────────── */

interface Options {
  kw: string;
  axis: string;
  slug: string;
  orphans: boolean;
  all: boolean;
  limit: number;
  min: number;
  local: boolean;
  json: string;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    kw: '',
    axis: '',
    slug: '',
    orphans: false,
    all: false,
    limit: DEFAULT_LIMIT,
    min: DEFAULT_MIN_SCORE,
    local: takeCommonFlag(argv, '--local'),
    json: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--kw') o.kw = (argv[++i] ?? '').trim();
    else if (a === '--axis') o.axis = (argv[++i] ?? '').trim();
    else if (a === '--slug') o.slug = (argv[++i] ?? '').trim();
    else if (a === '--orphans') o.orphans = true;
    else if (a === '--all') o.all = true;
    else if (a === '--limit') o.limit = Number(argv[++i] ?? '');
    else if (a === '--min') o.min = Number(argv[++i] ?? '');
    else if (a === '--json') o.json = (argv[++i] ?? '').trim();
    else die(`知らないオプション: ${a}`);
  }
  const modes = [o.kw, o.slug, o.orphans, o.all].filter(Boolean).length;
  if (modes !== 1) die('--kw / --slug / --orphans / --all のどれか1つを指定する');
  if (o.axis && !isAxisSlug(o.axis)) die(`--axis は gift / date / concierge のどれか: ${o.axis}`);
  if (!Number.isFinite(o.limit) || o.limit < 1) die('--limit は 1 以上の数');
  if (!Number.isFinite(o.min) || o.min < 0 || o.min > 1) die('--min は 0〜1 の数');
  return o;
}

/* ────────────────────────────────────────────────
 * 表示
 * ──────────────────────────────────────────────── */

/** Markdown の表のセル。縦棒と改行は表を壊すので落とす。 */
function cell(s: string): string {
  return s.replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
}

/** 『』に入れるタイトル。【2026年最新】などの装飾と「｜」以降は style-guide 11章のとおり落としてよい。 */
function plainTitle(title: string): string {
  return title
    .replace(/【[^】]*】/g, '')
    .replace(/[｜|].*$/, '')
    .trim();
}

function who(slug: string, title: string): string {
  return title ? `\`${slug}\` ${cell(title)}` : `\`${slug}\``;
}

/** 提案の表。KW 列は to のKW（「この段落は何の話をしているか」の根拠）。 */
function table(rows: LinkSuggestion[]): string {
  if (rows.length === 0) return '（該当なし）\n';
  const lines = [
    '| # | KW（to） | from | to | score | 行 | 抜粋 | 理由 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  rows.forEach((s, i) => {
    const to = s.to.slug ? who(s.to.slug, s.to.title) : '（新記事）';
    lines.push(
      `| ${i + 1} | ${cell(s.to.keyword)} | ${who(s.from.slug, s.from.title)} | ${to} | ${s.score.toFixed(2)} | ${s.line + 1} | ${cell(s.excerpt)} | ${cell(s.reason)} |`,
    );
  });
  return `${lines.join('\n')}\n`;
}

/**
 * 差し込み文の例（style-guide 11章の文型）。to ごとに1つ。
 * ◯◯は to のKWをそのまま置いている。書き手が自然な語に直す（「記念日 レストラン 予約 いつから」→「記念日ディナーの予約時期」）。
 * URL は /media/<slug>。新記事（slug 未定）は書き手が公開時の slug を入れる。
 */
function insertionExamples(rows: LinkSuggestion[]): string {
  const seen = new Set<string>();
  const out: string[] = ['（◯◯には to のKWをそのまま置いてある。「記念日ディナーの予約時期」のように自然な語へ直して使う。段落は分けて独立させる）'];
  for (const s of rows) {
    const key = s.to.slug || '(new)';
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = s.to.slug ? `[${plainTitle(s.to.title) || s.to.slug}](/media/${s.to.slug})` : '[新記事のタイトル](/media/<slug>)';
    const froms = rows.filter((r) => (r.to.slug || '(new)') === key).map((r) => `${r.from.slug}:${r.line + 1}行目`);
    out.push(`- to \`${s.to.slug || '（新記事）'}\`（from: ${froms.join('、')}）`);
    out.push(`  また、${s.to.keyword}については、${anchor}で解説していますのでぜひお読みください。`);
  }
  return out.length > 1 ? `${out.join('\n')}\n` : '';
}

function section(title: string): void {
  console.log(`\n## ${title}\n`);
}

function describe(a: SeoArticle): string {
  return `\`${a.slug}\` ${a.title}（${axisShort(a.axis) || '軸なし'}／${a.status === 'published' ? '公開' : '下書き'}）`;
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2));
const { articles } = loadSeoCatalog({ local: opts.local });
const graph = buildLinkGraph(articles);
const counts = linkCounts(articles, graph);
const published = articles.filter((a) => a.status === 'published');

console.log(
  `対象: ${opts.local ? 'ローカル' : '本番'} D1 / 記事 ${articles.length} 本（公開 ${published.length}）/ 足切り ${opts.min} / 上限 ${opts.limit}`,
);

const result: Record<string, unknown> = { generated_at: new Date().toISOString(), mode: '', opts };

if (opts.kw) {
  result.mode = 'kw';
  const rows = suggestLinksForKeyword(opts.kw, opts.axis, articles, { minScore: opts.min, limit: opts.limit });
  section(`「${opts.kw}」（${opts.axis ? axisShort(opts.axis) : '軸なし'}）へ、既存の公開記事のどこから張れるか`);
  console.log(table(rows));
  if (rows.length) {
    section('差し込み文の例（新記事を公開したら from 側に足す）');
    console.log(insertionExamples(rows));
  }
  result.suggestions = rows;
  // 新記事は被リンク 0 から始まるので、足切りで空になったら「近いのはどこか」だけでも出す。
  // 下限は 段落の半分一致（0.5）× 逆向き軸の重み（0.7）＝0.35。これ未満は走査の時点で候補にならない
  if (rows.length < 3) {
    const shown = new Set(rows.map((r) => r.from.slug));
    const near = suggestLinksForKeyword(opts.kw, opts.axis, articles, { minScore: MIN_COVERAGE * REVERSE_AXIS_WEIGHT, limit: opts.limit + 10 })
      .filter((r) => !shown.has(r.from.slug))
      .slice(0, 10);
    if (near.length) {
      section(`参考：足切り ${opts.min} に届かない近い候補（既存記事はこのKWの語に半分しか触れていない）`);
      console.log(table(near));
    }
    result.near = near;
  }
} else if (opts.slug) {
  result.mode = 'slug';
  const me = articles.find((a) => a.slug === opts.slug);
  if (!me) die(`slug が見つからない: ${opts.slug}`);
  const c = counts.get(me.slug) ?? { out: 0, in: 0 };
  console.log(`\n${describe(me)} … 発リンク ${c.out} / 被リンク ${c.in}`);
  const outgoing = [...(graph.out.get(me.slug) ?? [])];
  const incoming = [...(graph.in.get(me.slug) ?? [])];
  if (outgoing.length) console.log(`  → 張っている先: ${outgoing.join(', ')}`);
  if (incoming.length) console.log(`  ← 張られている元: ${incoming.join(', ')}`);

  const into = suggestLinks(articles, graph, { toSlug: me.slug, minScore: opts.min, limit: opts.limit, publishedOnly: false });
  section('この記事へ（被リンク候補）');
  console.log(table(into));
  if (into.length) {
    section('差し込み文の例');
    console.log(insertionExamples(into));
  }

  const from = suggestLinks(articles, graph, { fromSlug: me.slug, minScore: opts.min, limit: opts.limit, publishedOnly: false });
  section('この記事から（発リンク候補）');
  console.log(table(from));
  if (from.length) {
    section('差し込み文の例');
    console.log(insertionExamples(from));
  }
  result.article = { slug: me.slug, title: me.title, counts: c, outgoing, incoming };
  result.into = into;
  result.from = from;
} else if (opts.orphans) {
  result.mode = 'orphans';
  const orphans = findOrphans(articles, graph);
  section(`孤立記事（他の公開記事からリンクされていない）: ${orphans.length} 本`);
  const detail: Array<{ slug: string; title: string; axis: string; suggestions: LinkSuggestion[] }> = [];
  for (const o of orphans) {
    const c = counts.get(o.slug) ?? { out: 0, in: 0 };
    console.log(`- ${describe(o)} … 発リンク ${c.out}`);
    const into = suggestLinks(articles, graph, { toSlug: o.slug, minScore: opts.min, limit: 3 });
    detail.push({ slug: o.slug, title: o.title, axis: o.axis, suggestions: into });
  }
  for (const d of detail) {
    section(`\`${d.slug}\` へ張れる候補（上位3）`);
    console.log(table(d.suggestions));
    if (d.suggestions.length) console.log(insertionExamples(d.suggestions));
  }
  result.orphans = detail;
} else {
  result.mode = 'all';
  const rows = suggestLinks(articles, graph, { minScore: opts.min, limit: opts.limit });
  section('公開記事どうしの提案（score 降順）');
  console.log(table(rows));
  if (rows.length) {
    section('差し込み文の例');
    console.log(insertionExamples(rows));
  }
  result.suggestions = rows;
}

section('記事ごとの 発リンク / 被リンク');
for (const a of [...articles].sort((x, y) => (counts.get(x.slug)?.in ?? 0) - (counts.get(y.slug)?.in ?? 0))) {
  const c = counts.get(a.slug) ?? { out: 0, in: 0 };
  console.log(`- ${describe(a)} … 発 ${c.out} / 被 ${c.in}`);
}
result.counts = Object.fromEntries(counts);

if (opts.json) {
  const path = resolve(opts.json);
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\nJSON: ${path}`);
}
