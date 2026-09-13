/**
 * カニバリ（検索意図の重なり）の機械判定。
 *
 * `.claude/agents/reference/keyword-selection.md` 1章の dup / strong / weak をコードに写したもの。**ルールの正はあちら**。
 * ここを変えるときは向こうも直す（serp.ts と 2章の関係と同じ）。
 *
 *   dup    … 正規化すると同じKW。無条件で落とす
 *   strong … 検索意図が同じ可能性が高い。切り口をずらすか、既存記事のリライトに振る
 *   weak   … 語は重なるが切り口が違えば共存できる。人が見る
 *
 * 判定は tokens.ts の分かち書き・同義寄せに乗る。「ディナー」と「レストラン」を同じ語と見るのは
 * あちらの SYNONYM_GROUPS の責任で、ここは集合の重なりと軸・ファネルだけを見る。
 *
 * `cloudflare:workers` にも node:fs にも依存しない（管理画面とローカルスクリプトの両方から import する）。
 */
import { axisShort } from '../axis.ts';
import { scanArticleBlocks } from './internal-links.ts';
import { normalizeKeyword, overlap, textCoverage, tokenize } from './tokens.ts';
import type { CannibalHit, CannibalLevel, SeoArticle, SeoKeyword } from './types.ts';

/* ────────────────────────────────────────────────
 * 閾値
 * ──────────────────────────────────────────────── */

/**
 * Jaccard がこれ以上なら strong。
 * 4語KWどうしで3語が共通（{a,b,c,d} と {a,b,c,e}）が 3/5 = 0.6。1語違いは切り口が同じことが多い。
 * 3語どうしで2語共通は 2/4 = 0.5 で weak に落ちる（「記念日 レストラン 選び方」と「記念日 レストラン 予約」は別記事でよい）。
 */
export const STRONG_JACCARD = 0.6;
/**
 * Jaccard がこれ以上なら weak。これ未満は返さない。
 * 2語どうしで1語共通が 1/3 = 0.333。「記念日」1語の共通は全KWが持っているので意味がなく、
 * その境界のすぐ上に置く。3語と2語で2語共通（2/3）、3語どうしで2語共通（2/4）は拾う。
 */
export const WEAK_JACCARD = 0.34;
/**
 * 部分集合ルールと見出しルールを当てる最小語数。
 * 「記念日」1語はすべてのKWの部分集合で、すべての見出しに含まれるので、2語以上のときだけ見る。
 */
export const MIN_TOKENS_FOR_STRUCTURAL = 2;

/* ────────────────────────────────────────────────
 * 照合相手
 * ──────────────────────────────────────────────── */

/** 照合相手。台帳の1行か記事1本。記事は見出し（H2/H3）も持つ */
export interface CannibalTarget {
  kind: 'keyword' | 'article';
  id: number;
  keyword: string;
  /** 記事なら slug、台帳なら '' */
  slug: string;
  /** 記事ならタイトル、台帳なら keyword と同じ */
  title: string;
  axis: string;
  funnel: string;
  /** 記事の H2/H3 テキスト。台帳は [] */
  headings: string[];
  /** tokenize(keyword) のキャッシュ */
  tokens: string[];
}

/**
 * 台帳と記事から照合相手を作る。
 *   - dropped の台帳行は入れない（見送ったKWとの重なりは害がない）
 *   - article_id の先に記事があれば台帳行は入れない（記事側だけで照合する。done 行と記事で二重に出さない）
 *   - keyword が空の記事はタイトルで代用する（無視すると既存記事が照合から消える）
 */
export function buildTargets(keywords: SeoKeyword[], articles: SeoArticle[]): CannibalTarget[] {
  const out: CannibalTarget[] = [];
  const articleIds = new Set(articles.map((a) => a.id));
  for (const a of articles) {
    const keyword = a.keyword.trim() || a.title;
    out.push({
      kind: 'article',
      id: a.id,
      keyword,
      slug: a.slug,
      title: a.title,
      axis: a.axis,
      funnel: a.funnel,
      headings: scanArticleBlocks(a.body_md).headings,
      tokens: tokenize(keyword),
    });
  }
  for (const k of keywords) {
    if (k.status === 'dropped') continue;
    if (k.article_id !== null && articleIds.has(k.article_id)) continue;
    out.push({
      kind: 'keyword',
      id: k.id,
      keyword: k.keyword,
      slug: '',
      title: k.keyword,
      axis: k.axis,
      funnel: k.funnel,
      headings: [],
      tokens: tokenize(k.keyword),
    });
  }
  return out;
}

/* ────────────────────────────────────────────────
 * 1対1の判定
 * ──────────────────────────────────────────────── */

const LEVEL_RANK: Record<CannibalLevel, number> = { dup: 0, strong: 1, weak: 2 };

function byStrength(a: CannibalHit, b: CannibalHit): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.score - a.score || a.against.keyword.localeCompare(b.against.keyword);
}

function againstOf(t: CannibalTarget): CannibalHit['against'] {
  return { kind: t.kind, id: t.id, keyword: t.keyword, slug: t.slug, title: t.title, axis: t.axis, funnel: t.funnel };
}

function quoteAll(words: string[]): string {
  return words.join('・');
}

/**
 * 軸・ファネルが「同じと見なせるか」。片方が空（候補の軸が未定など）なら比較できないので同じ扱い
 * （見逃す方が高くつくので、分からないときは強い側に倒す）。
 */
function laneOf(axis: string, funnel: string, t: CannibalTarget): { same: boolean; note: string } {
  const axisSame = !axis || !t.axis || axis === t.axis;
  const funnelSame = !funnel || !t.funnel || funnel === t.funnel;
  if (axisSame && funnelSame) return { same: true, note: '同軸・同ファネル' };
  const parts: string[] = [];
  if (!axisSame) parts.push(`軸が違う（${axisShort(axis)}／${axisShort(t.axis)}）`);
  if (!funnelSame) parts.push(`ファネルが違う（${funnel}／${t.funnel}）`);
  return { same: false, note: parts.join('・') };
}

/**
 * 記事の見出し（H2/H3）かタイトルが**単独で**候補の全語を含むか。含む箇所の説明を返す（無ければ null）。
 * タイトルと見出しを合算しない：合算すると「タイトルに記念日・相場、どこかの見出しにレストラン」で
 * 代行料金の記事が「記念日 ディナー 相場」の共食いに見えた（実データで確認）。
 * 1つの見出しが全語を持っているなら、その節が同じ検索意図を扱っているとみてよい。
 */
function headingCover(tokens: string[], t: CannibalTarget): string | null {
  for (const h of t.headings) {
    if (textCoverage(h, tokens).ratio === 1) return `既存記事の見出し「${h}」が全語を含む`;
  }
  if (t.title && textCoverage(t.title, tokens).ratio === 1) return '既存記事のタイトルが全語を含む';
  return null;
}

/**
 * 候補（keyword）と相手（t）の1対1判定。当たらなければ null。
 *
 * 順番に意味がある：
 *   1. dup            … 正規化が一致
 *   2. 部分集合        … 片方がもう片方に語を足しただけ。軸とファネルが同じなら strong、違えば weak。
 *                        Jaccard より先に見るのは、{a,b,c}⊂{a,b,c,d} は Jaccard 0.75 で strong 圏なのに
 *                        「軸かファネルが違えば weak」（keyword-selection.md 1章の「切り口がズレていれば共存可」）
 *                        を効かせるため
 *   3. Jaccard ≥ 0.6  … strong
 *   4. 見出し          … 相手が記事で、タイトルか1つの見出しが候補の全語を含む → strong（もう本文で扱っている。
 *                        語の重なりが小さくても当てる。「誕生日プレゼント」のように分かち書きされていないKWは
 *                        Jaccard に乗らないので、このルールが拾う）
 *   5. Jaccard ≥ 0.34 … weak
 */
function judge(keyword: string, tokens: string[], norm: string, t: CannibalTarget, axis: string, funnel: string): CannibalHit | null {
  if (tokens.length === 0 || t.tokens.length === 0) return null;
  const against = againstOf(t);

  if (norm === normalizeKeyword(t.keyword)) {
    return { level: 'dup', score: 1, against, reason: `正規化すると同じKW（${quoteAll(tokens)}）` };
  }

  const ov = overlap(tokens, t.tokens);
  const union = tokens.length + t.tokens.length - ov.common.length;
  const commonNote = `共通語 ${ov.common.length}/${union}（${quoteAll(ov.common)}）`;
  const lane = laneOf(axis, funnel, t);
  const structural = Math.min(tokens.length, t.tokens.length) >= MIN_TOKENS_FOR_STRUCTURAL;

  if (structural && (ov.coverA === 1 || ov.coverB === 1)) {
    const shorter = tokens.length <= t.tokens.length ? keyword : t.keyword;
    if (lane.same) {
      return {
        level: 'strong',
        score: Math.max(ov.jaccard, STRONG_JACCARD),
        against,
        reason: `「${shorter}」に語を足しただけ（${commonNote}）／${lane.note}`,
      };
    }
    return {
      level: 'weak',
      score: Math.max(ov.jaccard, WEAK_JACCARD),
      against,
      reason: `「${shorter}」に語を足しただけだが ${lane.note} ので切り口が違う可能性（${commonNote}）`,
    };
  }

  if (ov.jaccard >= STRONG_JACCARD) {
    return { level: 'strong', score: ov.jaccard, against, reason: commonNote };
  }

  if (structural && t.kind === 'article') {
    const cover = headingCover(tokens, t);
    if (cover) {
      return {
        level: 'strong',
        score: Math.max(ov.jaccard, STRONG_JACCARD),
        against,
        reason: ov.common.length ? `${commonNote}／${cover}` : cover,
      };
    }
  }

  if (ov.jaccard >= WEAK_JACCARD) {
    return {
      level: 'weak',
      score: ov.jaccard,
      against,
      reason: lane.same ? commonNote : `${commonNote}／${lane.note}`,
    };
  }
  return null;
}

/**
 * 1つのKWが既存とぶつかるか。相手ごとに最も強い判定1件だけ（同じ相手に2件出さない）。
 * dup → strong → weak、同じ段では score 降順。
 *
 * excludeKeywordId / excludeArticleId は「自分自身」を外すため（台帳行の編集中、記事の編集中）。
 * 台帳行に article_id があるときは、その記事も excludeArticleId で外すこと（相手は記事側だけに入っている）。
 * axis / funnel は候補側の軸とファネル。未定なら渡さなくてよい（比較できない項目は同じ扱いになる）。
 */
export function detectCannibal(
  keyword: string,
  targets: CannibalTarget[],
  opts: { excludeKeywordId?: number; excludeArticleId?: number; axis?: string; funnel?: string } = {},
): CannibalHit[] {
  const tokens = tokenize(keyword);
  if (tokens.length === 0) return [];
  const norm = normalizeKeyword(keyword);
  const hits: CannibalHit[] = [];
  for (const t of targets) {
    if (opts.excludeKeywordId !== undefined && t.kind === 'keyword' && t.id === opts.excludeKeywordId) continue;
    if (opts.excludeArticleId !== undefined && t.kind === 'article' && t.id === opts.excludeArticleId) continue;
    const hit = judge(keyword, tokens, norm, t, opts.axis ?? '', opts.funnel ?? '');
    if (hit) hits.push(hit);
  }
  return hits.sort(byStrength);
}

/* ────────────────────────────────────────────────
 * 総当たり
 * ──────────────────────────────────────────────── */

/**
 * 台帳（todo / writing）と記事の総当たり。dup / strong だけ返す（weak は多すぎて画面が埋まる）。
 * 記事どうしも見る（公開済みの2本が同じ意図を取り合っているのを見つけるのもここの仕事）。
 * 見出しルールは向きがある（候補の語が相手の見出しにあるか）ので両向きに判定して強い方を採り、
 * `hit.against` が b になるよう並べて返す。
 */
export function cannibalMatrix(
  keywords: SeoKeyword[],
  articles: SeoArticle[],
): Array<{ a: CannibalTarget; b: CannibalTarget; hit: CannibalHit }> {
  const live = keywords.filter((k) => k.status === 'todo' || k.status === 'writing');
  const targets = buildTargets(live, articles);
  const norms = targets.map((t) => normalizeKeyword(t.keyword));
  const out: Array<{ a: CannibalTarget; b: CannibalTarget; hit: CannibalHit }> = [];
  for (let i = 0; i < targets.length; i++) {
    const a = targets[i]!;
    for (let j = i + 1; j < targets.length; j++) {
      const b = targets[j]!;
      const ab = judge(a.keyword, a.tokens, norms[i]!, b, a.axis, a.funnel);
      const ba = judge(b.keyword, b.tokens, norms[j]!, a, b.axis, b.funnel);
      let pick: { a: CannibalTarget; b: CannibalTarget; hit: CannibalHit } | null = null;
      if (ab && ba) pick = byStrength(ab, ba) <= 0 ? { a, b, hit: ab } : { a: b, b: a, hit: ba };
      else if (ab) pick = { a, b, hit: ab };
      else if (ba) pick = { a: b, b: a, hit: ba };
      if (pick && pick.hit.level !== 'weak') out.push(pick);
    }
  }
  return out.sort((x, y) => byStrength(x.hit, y.hit));
}

/* ────────────────────────────────────────────────
 * GSC の実測
 * ──────────────────────────────────────────────── */

/** 表示数がこれ未満のページは「たまたま出た」として無視する（既定）。 */
export const GSC_MIN_IMPRESSIONS = 10;

/**
 * GSC の実測：同じクエリに複数の記事が出ている。
 * 入力はクエリ×ページの行（日付で分かれていてもよい。同じ slug は足し合わせ、順位は表示数で加重平均）。
 * クエリは字面のまま束ねる（正規化して寄せると、順位が別クエリのものと混ざって読めなくなる）。
 * 表示数 minImpressions 未満のページは外し、2ページ以上残ったクエリだけ返す。表示数の多い順。
 */
export function gscCannibal(
  rows: Array<{ query: string; slug: string; clicks: number; impressions: number; position: number }>,
  opts: { minImpressions?: number } = {},
): Array<{ query: string; impressions: number; pages: Array<{ slug: string; clicks: number; impressions: number; position: number }> }> {
  const min = opts.minImpressions ?? GSC_MIN_IMPRESSIONS;
  const byQuery = new Map<string, Map<string, { clicks: number; impressions: number; posWeighted: number }>>();
  for (const r of rows) {
    const q = r.query.trim();
    if (!q || !r.slug) continue;
    let pages = byQuery.get(q);
    if (!pages) byQuery.set(q, (pages = new Map()));
    const p = pages.get(r.slug) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    p.clicks += r.clicks;
    p.impressions += r.impressions;
    p.posWeighted += r.position * r.impressions;
    pages.set(r.slug, p);
  }
  const out: Array<{ query: string; impressions: number; pages: Array<{ slug: string; clicks: number; impressions: number; position: number }> }> = [];
  for (const [query, pages] of byQuery) {
    const kept = [...pages]
      .filter(([, p]) => p.impressions >= min)
      .map(([slug, p]) => ({
        slug,
        clicks: p.clicks,
        impressions: p.impressions,
        position: p.impressions ? Math.round((p.posWeighted / p.impressions) * 10) / 10 : 0,
      }))
      .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions);
    if (kept.length < 2) continue;
    out.push({ query, impressions: kept.reduce((s, p) => s + p.impressions, 0), pages: kept });
  }
  return out.sort((x, y) => y.impressions - x.impressions);
}
