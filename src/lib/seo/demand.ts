/**
 * サジェスト深度スコア（需要スコア）。scripts/seo/suggest.ts が集めた SuggestRun から出す。
 *
 * **絶対量ではない。候補どうしの相対値**。「候補20個の中で上から何番目か」にしか使えない
 * （keyword-selection.md 4章）。サジェストは「検索されたことがある」しか示さないので、
 * 100 点でも月間検索数は 10 かもしれない。実数が要るなら volume.ts（Ahrefs／手動CSV／GSC）で付ける。
 *
 * 式（raw を最大値で割って 100 倍し、四捨五入したものが score）：
 *   - 候補 c が種KWそのまま（kind='seed'）のサジェストに r 位（1始まり）で出る → 10 × (1 − (r−1)/10)
 *       1位 10 点、10位 1 点、11位以降は 0 点
 *   - 種KW＋1文字（kind='expand'）で出る → 3 × (1 − (r−1)/10)
 *   - 複数のクエリに出れば合算。同じクエリに2回出ても1回しか数えない
 *   - 候補自身を種にしたクエリ（run に seed=c のクエリがあるとき）の派生サジェスト数 n → +0.5 × min(n, 10)
 *       「その語の先にさらに検索が枝分かれしているか」＝裾野の広さ。suggest.ts が上限 30 件だけ再展開する
 *
 * 種そのままを1文字展開の3倍強にしているのは、「記念日 サプライズ」の直下に出る語はその語で
 * 検索した人が多い順に並ぶのに対し、「記念日 サプライズ あ」の結果は「あ」で始まる語の中での順位に
 * すぎないため。裾野の上限を 5 点に抑えているのは、派生の数はクエリの長さ（短いほど多い）に
 * 引きずられるので、順位より弱い証拠として扱うため。
 */
import type { SuggestRun } from './types.ts';

export interface DemandResult {
  keyword: string;
  /** 0〜100。最大の候補を 100 とした相対値（整数） */
  score: number;
  /** 正規化前の合計点 */
  raw: number;
  /** 根拠。どのクエリの何位か／自身を種にした派生の数 */
  hits: string[];
}

/**
 * 同一候補の判定キー。Google は「記念日 サプライズ」と「記念日サプライズ」を別々に返すことがあるので
 * 空白を無かったことにして寄せる（爆速開発部の suggest_keywords.py と同じ）。
 * 同義語まで寄せる normalizeKeyword はここでは使わない——「ギフト」と「プレゼント」は別の検索語で、
 * どちらが検索されているかは候補として見たい。suggest.ts が種KWの紐づけに同じキーを使うので export。
 */
export function suggestKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');
}

const ident = suggestKey;

/** 表示用。空白の連続だけ1つに寄せて、最初に見た表記をそのまま使う。 */
function display(s: string): string {
  return s.replace(/[\s　]+/g, ' ').trim();
}

/** run から候補KWごとのスコアを出す。score 降順（同点は raw 降順、次に文字順）。 */
export function demandScores(run: SuggestRun): DemandResult[] {
  const acc = new Map<string, { keyword: string; raw: number; hits: string[] }>();
  const entry = (s: string) => {
    const k = ident(s);
    let e = acc.get(k);
    if (!e) {
      e = { keyword: display(s), raw: 0, hits: [] };
      acc.set(k, e);
    }
    return e;
  };

  // 同じクエリが run に2回入っていても1回分しか数えない（suggest.ts は重複を避けるが、手で繋いだ run にも耐える）
  const seenQuery = new Set<string>();
  const queries = run.queries.filter((q) => {
    const k = `${q.kind}:${ident(q.q)}`;
    if (seenQuery.has(k)) return false;
    seenQuery.add(k);
    return true;
  });

  for (const q of queries) {
    const weight = q.kind === 'seed' ? 10 : 3;
    const seen = new Set<string>();
    q.results.forEach((s, i) => {
      const k = ident(s);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const pts = weight * (1 - i / 10);
      if (pts <= 0) return;
      const e = entry(s);
      e.raw += pts;
      e.hits.push(`「${q.q}」${i + 1}位`);
    });
  }

  // 裾野。候補自身を種にしたクエリの派生数を、その候補に足す。
  // 種そのものが候補に上がっていない（どのサジェストにも出ていない）なら加点先が無いので飛ばす。
  for (const q of queries) {
    if (q.kind !== 'seed') continue;
    const self = ident(q.seed);
    const e = acc.get(self);
    if (!e) continue;
    const n = new Set(q.results.map(ident).filter((k) => k && k !== self)).size;
    if (n === 0) continue;
    e.raw += 0.5 * Math.min(n, 10);
    e.hits.push(`自身を種に ${n} 件`);
  }

  const list = [...acc.values()].filter((e) => e.raw > 0);
  const max = list.reduce((m, e) => Math.max(m, e.raw), 0);
  return list
    .map((e) => ({
      keyword: e.keyword,
      score: max > 0 ? Math.round((e.raw / max) * 100) : 0,
      raw: Math.round(e.raw * 100) / 100,
      hits: e.hits,
    }))
    .sort((a, b) => b.score - a.score || b.raw - a.raw || a.keyword.localeCompare(b.keyword, 'ja'));
}
