/**
 * 競合の Instagram 投稿を評価する純粋関数。scripts/seo/ig-scan.ts（レポート）と管理画面（/admin/competitors）が共有する。
 * `cloudflare:workers` にも node:* にも依存しない（types.ts と同じ理由。相対 import は `.ts` 付き）。
 *
 * 物差しは メディア方針/SNS戦略.md 4章「伸びている投稿の分解」「勝ちパターン6則」。ここに書いてある読み方を機械に写す。
 *   - 伸びたかどうかは**フォロワー数で比べない**。同じアカウント内の中央値に対する倍率（ratio）で見る
 *     （同じアカウント・同じデザインでいいねが 13〜118 と9倍ひらき、差は題材だけだった）
 *   - 6則のうちキャプションから機械で見えるのは 規則1・3（相手＋数字）、規則5（1行目のプロフィール誘導）、
 *     規則6（Anniv の独壇場に踏み込んでいるか）。規則2（2枚目の「保存する理由」）と規則4（締めの自己紹介）は
 *     スライドの中身なので見ない
 *
 * 判定語はこのファイルの先頭に定数で置く。増やすときは SNS戦略.md 4章の規則番号と対応させる。
 */
import type { CompetitorAccount, CompetitorPost, CompetitorPostStat, PostScore } from './types.ts';

/* ────────────────────────────────────────────────
 * 判定語（SNS戦略.md 4章）
 * ──────────────────────────────────────────────── */

/**
 * 規則1・3：相手・状況の明示。「彼氏に喜ばれる 76 vs 敬老の日 13」——相手が読者側（カップル）に寄っているほど強い。
 * 1文字の語（妻・夫）は「工夫」「夫婦」に当たるので助詞付きで持つ。
 */
export const AUDIENCE_WORDS: readonly string[] = [
  '彼氏', '彼女', 'カップル', '恋人', 'パートナー', '夫婦',
  '妻に', '妻へ', '妻の', '夫に', '夫へ', '夫の', '旦那', '奥さん',
  '20代', '30代', '40代', '付き合って', '同棲', '遠距離', 'プロポーズ', '結婚記念日',
  '記念日に', '誕生日に', '女性', '男性', '女子', '男子',
];

/** 規則1・3：数字。「35選 118 vs 7選 76」、数字の無い「渡し方」は 34。全角数字は NFKC で寄せてから当てる */
export const NUMBER_RE = /\d+\s*(?:万|千)?\s*(?:選|つ|個|パターン|ステップ|円|例|品|種類?|箇所|か所|ヶ所|ヵ所)/;

/** 規則5：1行目のプロフィール誘導に付く矢印。`@ico_present 👈彼女が喜ぶギフトを見る` `@epocha_cha ◀サプライズアイデアを検索！` */
export const CTA_ARROWS: readonly string[] = ['◀', '←', '👈', '👉', '▶', '→', '⬅', '➡', '◁', '▷'];

/**
 * 規則6：Anniv の独壇場（店に何を頼めるか・いくらか・いつまでか／予算の内訳／当日までの段取りと店に送る文面）。
 * ギフトECもカップル発信も書けない領域なので、ここに当たる投稿は「競合が踏み込んできた」警戒フラグ。
 */
export const TERRITORY_WORDS: readonly string[] = [
  '店', 'レストラン', 'ディナー', '予約', '締切', '締め切り', '日前', '持ち込み', '持込',
  '予算', '内訳', '段取り', '手配', '文面', 'ホテル', 'プレート', 'ケーキ', '花束',
];

/** フックの上限（文字） */
const HOOK_MAX = 120;
/** 相手・数字を見る範囲＝キャプション冒頭の行数（表紙の見出しがここに来る。本文やハッシュタグまで見ると全部に当たる） */
const HEAD_LINES = 3;
/** 中央値を出すのに要る最少本数 */
const MEDIAN_MIN = 3;

/* ────────────────────────────────────────────────
 * キャプションの読み方
 * ──────────────────────────────────────────────── */

const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const stripHashtags = (s: string) => s.replace(/[#＃][^\s#＃]+/g, ' ');
/** 文字か数字を1つでも含む行（絵文字・罫線・「・・・」だけの行を落とす） */
const hasContent = (line: string) => /[\p{L}\p{N}]/u.test(line);
const MENTION_RE = /@[a-z0-9_.]+/;

/** 空行と記号だけの行を除いた行の配列（前後の空白は落とす） */
function contentLines(caption: string): string[] {
  return caption
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && hasContent(l));
}

/**
 * その行がプロフィール誘導か（規則5）。@メンション＋矢印。
 * `@handle` に限定しない——psypre は `@psypre_giftshop ←ギフトショップ運営中` と別アカウントへ誘導していて、
 * SNS戦略.md はそれも「例外なし」の側に数えている。
 */
function isProfileCta(line: string): boolean {
  const l = norm(line);
  return MENTION_RE.test(l) && CTA_ARROWS.some((a) => l.includes(a));
}

/**
 * キャプションのフック。空行・記号だけの行は飛ばし、120字で切る。
 * 1行目がプロフィール誘導（規則5）ならその次の行を返す——誘導行は毎回同じ文言なので、
 * 「その投稿が何の話か」を表す行としては役に立たない。
 */
export function hookOf(caption: string): string {
  const lines = contentLines(caption);
  const line = lines.find((l) => !isProfileCta(l)) ?? lines[0] ?? '';
  const chars = [...line];
  return chars.length > HOOK_MAX ? chars.slice(0, HOOK_MAX).join('') + '…' : line;
}

/**
 * 勝ちパターン6則のうち機械で見える4つ。
 *   audience / number … 冒頭 HEAD_LINES 行（誘導行とハッシュタグを除く）で見る。表紙の見出しがここに来る
 *   profileCta        … 1行目（内容のある最初の行）が @メンション＋矢印
 *   annivTerritory    … キャプション全体（ハッシュタグ除く）に規則6の語のどれか
 * handle は「自分への誘導か」の確認用。別アカウントへの誘導も規則5に数えるので判定には効かないが、
 * 呼び出し側が持っている情報なので受け取っておく（画面で「@自分」と「@別垢」を分けたくなったときの口）。
 */
export function detectPattern(caption: string, handle: string): PostScore['pattern'] {
  const lines = contentLines(caption);
  const first = lines[0] ?? '';
  const profileCta = isProfileCta(first) || (handle !== '' && norm(first).includes(`@${norm(handle)}`) && CTA_ARROWS.some((a) => first.includes(a)));

  const head = norm(
    stripHashtags(
      lines
        .filter((l) => !isProfileCta(l))
        .slice(0, HEAD_LINES)
        .join('\n'),
    ),
  );
  const body = norm(stripHashtags(caption));

  return {
    audience: AUDIENCE_WORDS.some((w) => head.includes(norm(w))),
    number: NUMBER_RE.test(head),
    profileCta,
    annivTerritory: TERRITORY_WORDS.some((w) => body.includes(norm(w))),
  };
}

/* ────────────────────────────────────────────────
 * 評価
 * ──────────────────────────────────────────────── */

const engagementOf = (p: Pick<CompetitorPost, 'like_count' | 'comments_count'>) => (p.like_count ?? 0) + (p.comments_count ?? 0);

function median(values: number[]): number | null {
  if (values.length < MEDIAN_MIN) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 同じ投稿が api と manual の両方で入っているときの優先順（permalink で束ねる） */
const SOURCE_RANK: Record<CompetitorPost['source'], number> = { api: 0, manual: 1, hashtag: 2 };

/** 順序：ratio 降順（null は末尾）→ engagement 降順 → 投稿日の新しい順 */
function compareScore(a: PostScore, b: PostScore): number {
  if (a.ratio !== null && b.ratio !== null && a.ratio !== b.ratio) return b.ratio - a.ratio;
  if ((a.ratio === null) !== (b.ratio === null)) return a.ratio === null ? 1 : -1;
  if (a.engagement !== b.engagement) return b.engagement - a.engagement;
  return b.post.posted_at.localeCompare(a.post.posted_at);
}

/**
 * 投稿を評価する。
 *   engagement … like_count + comments_count（null は 0）
 *   median     … 同じアカウント内（source が api か manual）の engagement の中央値。3本未満なら null。
 *                hashtag 経由の投稿は出どころのアカウントがばらばらなので中央値を持たない（ratio も null）
 *   ratio      … engagement / median（中央値が 0 なら null）
 *   delta      … stats の直近2断面の like_count の差。断面が1つしか無ければ null
 * 同じ permalink の投稿が api と manual で二重に入っているときは api を残す（手動取り込みのあとに API が動き出した回）。
 * 戻りは ratio 降順（null は末尾）。
 */
export function scorePosts(
  posts: CompetitorPost[],
  accounts: CompetitorAccount[],
  stats: Map<string, CompetitorPostStat[]>,
): PostScore[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // permalink で束ねて二重を落とす
  const byKey = new Map<string, CompetitorPost>();
  for (const p of posts) {
    const key = p.permalink ? `${p.account_id}:${p.permalink.replace(/\/+$/, '').toLowerCase()}` : `id:${p.id}`;
    const cur = byKey.get(key);
    if (!cur || SOURCE_RANK[p.source] < SOURCE_RANK[cur.source]) byKey.set(key, p);
  }
  const unique = [...byKey.values()];

  // アカウント内の中央値
  const engagements = new Map<number, number[]>();
  for (const p of unique) {
    if (p.source === 'hashtag') continue;
    const list = engagements.get(p.account_id) ?? [];
    list.push(engagementOf(p));
    engagements.set(p.account_id, list);
  }
  const medians = new Map<number, number | null>();
  for (const [id, list] of engagements) medians.set(id, median(list));

  const scores = unique.map((post): PostScore => {
    const account: CompetitorAccount = accountById.get(post.account_id) ?? {
      id: post.account_id,
      platform: 'instagram',
      handle: `(account ${post.account_id})`,
      label: '',
      kind: '',
      active: 0,
      followers: null,
      media_count: null,
      fetched_at: '',
      note: '',
    };
    const engagement = engagementOf(post);
    const med = post.source === 'hashtag' ? null : (medians.get(post.account_id) ?? null);
    const ratio = med !== null && med > 0 ? engagement / med : null;

    const snapshots = [...(stats.get(post.id) ?? [])].sort((a, b) => a.ymd.localeCompare(b.ymd));
    let delta: number | null = null;
    if (snapshots.length >= 2) {
      const last = snapshots[snapshots.length - 1]!;
      const prev = snapshots[snapshots.length - 2]!;
      if (last.like_count !== null && prev.like_count !== null) delta = last.like_count - prev.like_count;
    }

    return {
      post,
      account,
      engagement,
      median: med,
      ratio,
      delta,
      pattern: detectPattern(post.caption, account.handle),
      hook: hookOf(post.caption),
    };
  });

  return scores.sort(compareScore);
}

/** 上位 n 件。ratio が null のものは engagement 降順で末尾に */
export function topPosts(scores: PostScore[], n: number): PostScore[] {
  return [...scores].sort(compareScore).slice(0, Math.max(0, n));
}

/** パターンの当たりを集計する（上位群と全体で「相手明示」「数字」…の割合を比べるため） */
export function patternSummary(scores: PostScore[]): Record<keyof PostScore['pattern'], { hit: number; total: number }> {
  const keys: (keyof PostScore['pattern'])[] = ['audience', 'number', 'profileCta', 'annivTerritory'];
  const out = {} as Record<keyof PostScore['pattern'], { hit: number; total: number }>;
  for (const k of keys) out[k] = { hit: scores.filter((s) => s.pattern[k]).length, total: scores.length };
  return out;
}
