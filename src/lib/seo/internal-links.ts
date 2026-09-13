/**
 * 内部リンクのグラフと提案。
 *
 * 記事本文の `/media/<slug>` を拾ってグラフにし、
 *   - 誰からもリンクされていない公開記事（孤立）
 *   - 「from の段落が to のKWに触れているのに from→to のリンクが無い」場所
 * を出す。提案は style-guide 11章の文型（段落を分けて「また、◯◯については、『タイトル』で解説して
 * いますのでぜひお読みください。」）を作れる情報＝from の段落の位置と抜粋、to のタイトルと slug を持つ。
 *
 * 軸の向きに重みを付けるのは、メディア戦略.md 3章の導線（軸1→軸2→軸3→無料相談）に沿った提案を
 * 上に出すため。逆向き（代行→ギフト）のリンクが要らないわけではないが、同じ段落から張れるなら
 * 無料相談に近づく向きを先に見たい。
 *
 * `cloudflare:workers` にも node:fs にも依存しない（管理画面とローカルスクリプトの両方から import する）。
 * 本文の走査に使う正規表現は src/lib/quality.ts の scanHeadings / plainText / internalLinks から写した。
 * あちらと判定がズレると「公開前チェックは通るのに提案には出ない」が起きるので、変えるときは両方直す。
 */
import { axisShort } from '../axis.ts';
import { textCoverage, tokenize } from './tokens.ts';
import type { LinkGraph, LinkSuggestion, SeoArticle } from './types.ts';

/* ────────────────────────────────────────────────
 * 閾値
 * ──────────────────────────────────────────────── */

/**
 * 段落が to のKWの何割の語に触れていれば候補にするか。
 * 4語KWなら2語、3語KWなら2語。これより下げると「記念日」「店」の2語で当たる段落だらけになる。
 */
export const MIN_COVERAGE = 0.5;
/**
 * この語数以下のKWは全語一致を要求する。「記念日 プレゼント」の半分＝「記念日」1語で
 * 全段落に当たってしまうのを防ぐ。
 */
export const SHORT_KW_TOKENS = 2;
/** 既定の足切り。同軸で半分触れている（0.5×1.0）を残し、逆向き軸で半分（0.5×0.7）は落とす。 */
export const DEFAULT_MIN_SCORE = 0.5;
export const DEFAULT_LIMIT = 50;
/** 抜粋の長さ。管理画面の1行と CLI の表に収まる長さ。 */
export const EXCERPT_LENGTH = 120;

/**
 * 軸の向きの重み。メディア戦略.md 3章「軸1→軸2→軸3→無料相談」が基本導線。
 * 同軸は 1.0。導線に沿う向きは 0.85〜0.95（gift→date だけ少し低いのは、軸3を経由せず
 * デートに流れるより代行に直接つなぐ方が CV に近いため）。逆向きは 0.7 で残す（消さない）。
 * 軸が空・未知のときは 0.85（判断材料が無いので中立）。
 */
export const REVERSE_AXIS_WEIGHT = 0.7;
const AXIS_WEIGHTS: Record<string, number> = {
  'gift>date': 0.85,
  'gift>concierge': 0.95,
  'date>concierge': 0.95,
  'date>gift': REVERSE_AXIS_WEIGHT,
  'concierge>gift': REVERSE_AXIS_WEIGHT,
  'concierge>date': REVERSE_AXIS_WEIGHT,
};
const UNKNOWN_AXIS_WEIGHT = 0.85;

export function axisWeight(fromAxis: string, toAxis: string): number {
  if (!fromAxis || !toAxis) return UNKNOWN_AXIS_WEIGHT;
  if (fromAxis === toAxis) return 1;
  return AXIS_WEIGHTS[`${fromAxis}>${toAxis}`] ?? UNKNOWN_AXIS_WEIGHT;
}

/* ────────────────────────────────────────────────
 * 本文の走査（quality.ts と同じ正規表現）
 * ──────────────────────────────────────────────── */

/** コードブロックの開始・終了行。 */
const FENCE_RE = /^\s*(```|~~~)/;
/** カスタムブロック（:::name / ::::columns …）の開始と、名前なしの閉じ。 */
const CONTAINER_RE = /^(:{3,})\s*([a-zA-Z][\w-]*)?/;
/** 本文の末尾に閉じの `:::` が書かれている行（`… 決める :::`）。quality.ts と同じ扱いで「閉じ」と見なす。 */
const FENCE_TAIL_RE = /^(.*?[^\s:])\s*(:{3,})\s*$/;
/** 既に箇条書き・見出し・引用・表・画像・リンク始まりになっている行。リンクの段落を置ける「普通の段落」ではない。 */
const NOT_PLAIN_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||!\[|\[)/;
/** 区切り線。 */
const HR_RE = /^\s*-{3,}\s*$/;
/** H2 / H3。 */
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;
/** 内部リンク（/media/<slug>）。絶対URLで書かれていても拾う。 */
const INTERNAL_LINK_RE = /\]\((?:https?:\/\/anniv\.gift)?\/media\/([a-z0-9-]+)\/?\)/g;

export interface Paragraph {
  /** 段落の先頭行（0始まり。エディタで飛ぶ用） */
  line: number;
  /** Markdown の装飾を落とした本文。改行は空白 */
  text: string;
  /** 既に内部リンクを含む（この段落にはもう置けない） */
  hasInternalLink: boolean;
}

export interface ArticleBlocks {
  /** H2/H3 のテキスト（先頭の【タグ】は落とす。timeline / details の中は見出しではない） */
  headings: string[];
  /** リンクの段落を置ける「普通の段落」だけ。コンテナ・表・箇条書き・画像・コードは含まない */
  paragraphs: Paragraph[];
}

/** 段落1つぶんの装飾落とし。plainText のインライン部分と同じ。 */
function inlineText(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/==[gp]:/g, '')
    .replace(/==/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 本文を「見出し」と「普通の段落」に割る。
 *
 *   - 段落＝空行で区切られた連続行。コードブロック・コンテナ（:::）の中は段落にしない
 *     （内部リンクは本文の流れに独立した段落として置く＝style-guide 11章。囲みの中には置かない）
 *   - 先頭に frontmatter が残っていれば飛ばす（行番号は本文全体で数えるので、飛ばしてもズレない）
 *   - 見出しは scanHeadings と同じ条件（timeline / details の中は拾わない）
 */
export function scanArticleBlocks(body: string): ArticleBlocks {
  const lines = body.split('\n');
  const headings: string[] = [];
  const paragraphs: Paragraph[] = [];
  const stack: string[] = [];
  let inFence = false;
  let buf: string[] = [];
  let bufStart = -1;

  const flush = () => {
    if (buf.length) {
      const raw = buf.join('\n');
      INTERNAL_LINK_RE.lastIndex = 0;
      paragraphs.push({ line: bufStart, text: inlineText(raw), hasInternalLink: INTERNAL_LINK_RE.test(raw) });
    }
    buf = [];
    bufStart = -1;
  };

  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }

  for (; i < lines.length; i++) {
    let line = lines[i]!;

    if (FENCE_RE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 行末の閉じフェンス。行の本文はコンテナの中身なので段落にはしない
    if (stack.length && FENCE_TAIL_RE.test(line)) {
      flush();
      stack.pop();
      continue;
    }
    const c = line.match(CONTAINER_RE);
    if (c) {
      flush();
      if (c[2]) stack.push(c[2]);
      else stack.pop();
      continue;
    }

    const h = line.match(HEADING_RE);
    if (h) {
      flush();
      if (!stack.includes('timeline') && !stack.includes('details')) {
        headings.push(h[2]!.replace(/^【[^】]*】\s*/, '').trim());
      }
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    if (stack.length) continue;
    if (NOT_PLAIN_LINE_RE.test(line) || HR_RE.test(line)) {
      flush();
      continue;
    }
    if (buf.length === 0) bufStart = i;
    buf.push(line);
  }
  flush();
  return { headings, paragraphs };
}

/** 本文中の内部リンク先 slug（重複なし）。 */
export function internalLinkSlugs(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  INTERNAL_LINK_RE.lastIndex = 0;
  while ((m = INTERNAL_LINK_RE.exec(body)) !== null) out.add(m[1]!);
  return [...out];
}

/* ────────────────────────────────────────────────
 * グラフ
 * ──────────────────────────────────────────────── */

/**
 * 本文の `/media/<slug>` を拾ってグラフにする。下書きも含めて全記事。
 * slug が実在しないリンク（打ち間違い・削除済み）と自己リンクは無視する。
 * 公開／下書きの絞り込みはここではせず、findOrphans / linkCounts 側でやる
 * （グラフは事実の記録、絞り込みは用途ごとに違うため）。
 */
export function buildLinkGraph(articles: SeoArticle[]): LinkGraph {
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const known = new Set(articles.map((a) => a.slug).filter(Boolean));
  for (const slug of known) {
    out.set(slug, new Set());
    inn.set(slug, new Set());
  }
  for (const a of articles) {
    if (!a.slug) continue;
    for (const to of internalLinkSlugs(a.body_md)) {
      if (to === a.slug || !known.has(to)) continue;
      out.get(a.slug)!.add(to);
      inn.get(to)!.add(a.slug);
    }
  }
  return { out, in: inn };
}

/** 公開記事のうち、他の公開記事から1本もリンクされていないもの（下書きからのリンクは数えない＝本番では存在しない）。 */
export function findOrphans(articles: SeoArticle[], graph: LinkGraph): SeoArticle[] {
  const published = new Set(articles.filter((a) => a.status === 'published').map((a) => a.slug));
  return articles.filter((a) => {
    if (a.status !== 'published' || !a.slug) return false;
    const sources = graph.in.get(a.slug);
    if (!sources) return true;
    for (const s of sources) if (published.has(s)) return false;
    return true;
  });
}

/**
 * 記事ごとの 発リンク数 / 被リンク数。
 * 発リンク＝本文が指している実在の記事の数（下書き相手も含む。書いてあるものは書いてある）。
 * 被リンク＝公開記事から張られている数（findOrphans と同じ物差し。0 なら孤立）。
 */
export function linkCounts(articles: SeoArticle[], graph: LinkGraph): Map<string, { out: number; in: number }> {
  const published = new Set(articles.filter((a) => a.status === 'published').map((a) => a.slug));
  const counts = new Map<string, { out: number; in: number }>();
  for (const a of articles) {
    if (!a.slug) continue;
    let inn = 0;
    for (const s of graph.in.get(a.slug) ?? []) if (published.has(s)) inn++;
    counts.set(a.slug, { out: graph.out.get(a.slug)?.size ?? 0, in: inn });
  }
  return counts;
}

/* ────────────────────────────────────────────────
 * 提案
 * ──────────────────────────────────────────────── */

interface LinkTarget {
  slug: string;
  title: string;
  keyword: string;
  axis: string;
  tokens: string[];
}

function axisNote(fromAxis: string, toAxis: string): string {
  if (fromAxis && fromAxis === toAxis) return '同軸';
  return `${axisShort(fromAxis) || '軸なし'}→${axisShort(toAxis) || '軸なし'}`;
}

function excerptOf(text: string): string {
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
}

/**
 * from の段落を全部見て、to のKWに最も触れている段落を1つ返す。
 * 同点なら先に出てくる段落（最初に話題が出た場所にリンクを置く方が読みの流れに合う）。
 */
function bestParagraph(
  from: SeoArticle,
  blocks: ArticleBlocks,
  to: LinkTarget,
  minScore: number,
): LinkSuggestion | null {
  if (to.tokens.length === 0) return null;
  const need = to.tokens.length <= SHORT_KW_TOKENS ? 1 : MIN_COVERAGE;
  const weight = axisWeight(from.axis, to.axis);
  let best: { p: Paragraph; hit: string[]; score: number } | null = null;
  for (const p of blocks.paragraphs) {
    if (p.hasInternalLink) continue;
    const cov = textCoverage(p.text, to.tokens);
    if (cov.ratio < need) continue;
    const score = Math.round(cov.ratio * weight * 1000) / 1000;
    if (score < minScore) continue;
    if (!best || score > best.score) best = { p, hit: cov.hit, score };
  }
  if (!best) return null;
  return {
    from: { slug: from.slug, title: from.title, axis: from.axis },
    to: { slug: to.slug, title: to.title, keyword: to.keyword, axis: to.axis },
    score: best.score,
    excerpt: excerptOf(best.p.text),
    line: best.p.line,
    reason: `段落が${best.hit.map((t) => `「${t}」`).join('')}に触れている（${best.hit.length}/${to.tokens.length}語）／${axisNote(from.axis, to.axis)}`,
  };
}

function toTarget(a: SeoArticle): LinkTarget {
  // keyword が空の記事（手で入れた古いもの）はタイトルで代用する。無視すると提案の宛先から消える
  const keyword = a.keyword.trim() || a.title;
  return { slug: a.slug, title: a.title, keyword, axis: a.axis, tokens: tokenize(keyword) };
}

function byScore(a: LinkSuggestion, b: LinkSuggestion): number {
  return b.score - a.score || a.from.slug.localeCompare(b.from.slug) || a.line - b.line;
}

/**
 * 既存記事どうしの提案。「from の本文の段落が to のKWに触れているのに from→to のリンクが無い」を探す。
 * toSlug を渡すと「この記事へどこから張れるか」、fromSlug を渡すと「この記事からどこへ張れるか」に絞る。
 * 同じ from→to は最もスコアの高い段落1件だけ。score 降順。
 */
export function suggestLinks(
  articles: SeoArticle[],
  graph: LinkGraph,
  opts: { toSlug?: string; fromSlug?: string; minScore?: number; limit?: number; publishedOnly?: boolean } = {},
): LinkSuggestion[] {
  const publishedOnly = opts.publishedOnly ?? true;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const pool = articles.filter((a) => a.slug && (!publishedOnly || a.status === 'published'));
  const froms = opts.fromSlug ? pool.filter((a) => a.slug === opts.fromSlug) : pool;
  const tos = (opts.toSlug ? pool.filter((a) => a.slug === opts.toSlug) : pool).map(toTarget);

  const out: LinkSuggestion[] = [];
  for (const from of froms) {
    const blocks = scanArticleBlocks(from.body_md);
    const linked = graph.out.get(from.slug) ?? new Set<string>();
    for (const to of tos) {
      if (to.slug === from.slug || linked.has(to.slug)) continue;
      const s = bestParagraph(from, blocks, to, minScore);
      if (s) out.push(s);
    }
  }
  return out.sort(byScore).slice(0, limit);
}

/**
 * まだ記事が無いKW（これから書く1本）に対して、既存の公開記事のどこから張れるかを出す。
 * 仮想の to（slug '' / title ''）を作って suggestLinks と同じ手順で走査する。
 * /anniv-write-article が「内部リンク指定」を組むときの材料。
 */
export function suggestLinksForKeyword(
  keyword: string,
  axis: string,
  articles: SeoArticle[],
  opts: { minScore?: number; limit?: number } = {},
): LinkSuggestion[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const to: LinkTarget = { slug: '', title: '', keyword, axis, tokens: tokenize(keyword) };
  const out: LinkSuggestion[] = [];
  for (const from of articles) {
    if (!from.slug || from.status !== 'published') continue;
    const s = bestParagraph(from, scanArticleBlocks(from.body_md), to, minScore);
    if (s) out.push(s);
  }
  return out.sort(byScore).slice(0, limit);
}
