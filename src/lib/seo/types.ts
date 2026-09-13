/**
 * SEO ツール群（KW選定・カニバリ検出・内部リンク提案）で共有する型。
 *
 * `src/lib/seo/` は **`cloudflare:workers` に依存しない純粋関数だけ**で書く。
 * 管理画面（Worker）とローカルのスクリプト（scripts/seo/*.ts）の両方から import するため。
 * D1 に触るのは Worker 側なら src/lib/db.ts、ローカルなら scripts/seo/_d1.ts。
 *
 * 相対 import に `.ts` を付けるのも同じ理由（kw-csv.ts と同じ。node の型剥がしは拡張子を推測しない）。
 */
import type { AxisSlug, Funnel } from '../axis.ts';

/* ────────────────────────────────────────────────
 * 既存の資産（台帳と記事）。カニバリ・内部リンクの照合相手
 * ──────────────────────────────────────────────── */

/** 台帳の1行のうち、判定に要る列だけ。 */
export interface SeoKeyword {
  id: number;
  keyword: string;
  axis: string;
  funnel: string;
  status: 'todo' | 'writing' | 'done' | 'dropped';
  article_id: number | null;
  /** 種KW（クラスタ）。空なら未設定 */
  seed: string;
}

/** 記事のうち、判定に要る列だけ。本文は内部リンクの走査に使う。 */
export interface SeoArticle {
  id: number;
  slug: string;
  title: string;
  keyword: string;
  axis: string;
  funnel: string;
  status: 'draft' | 'published';
  body_md: string;
}

/* ────────────────────────────────────────────────
 * カニバリ（検索意図の重なり）
 * ──────────────────────────────────────────────── */

/**
 * dup    … 正規化すると同じKW。書いたら確実に共食いする
 * strong … 検索意図が同じ可能性が高い。切り口をずらすか、既存記事のリライトに振る
 * weak   … 語は重なるが切り口が違えば共存できる。人が見て決める
 */
export type CannibalLevel = 'dup' | 'strong' | 'weak';

export interface CannibalHit {
  level: CannibalLevel;
  /** 0〜1。1 が完全一致 */
  score: number;
  /** 何とぶつかったか */
  against: {
    kind: 'keyword' | 'article';
    id: number;
    keyword: string;
    /** 記事なら slug、台帳なら空 */
    slug: string;
    title: string;
    axis: string;
    funnel: string;
  };
  /** 画面と CLI にそのまま出す1行 */
  reason: string;
}

/* ────────────────────────────────────────────────
 * KW候補（/anniv-pick-keyword の中間成果物）
 *
 * suggest.ts が作り、volume.ts が数字を足し、add-keywords.ts が D1 に入れる。
 * `記事管理/KW候補/<日付>_<軸>.json` にこの配列で置く。
 * ──────────────────────────────────────────────── */

/** 需要の数字の出どころ。上ほど信頼できる（keyword-selection.md 4章）。 */
export type VolumeSource = 'ahrefs' | 'csv' | 'gsc' | null;

export interface KwCandidate {
  keyword: string;
  /** どの種KWの展開で出てきたか */
  seed: string;
  axis: AxisSlug | '';
  funnel: Funnel | '';
  /** サジェスト深度スコア（0〜100・候補どうしの相対値）。src/lib/seo/demand.ts */
  demand: number | null;
  /** 月間検索数の実数。無ければ null */
  volume: number | null;
  volumeSource: VolumeSource;
  /** Ahrefs の Keyword Difficulty（0〜100）。無ければ null */
  kd: number | null;
  /** GSC の表示数（既に露出している領域だけ入る） */
  gscImpr: number | null;
  /** 既出。台帳か記事に同じKWがある */
  known: 'keyword' | 'article' | null;
  cannibal: CannibalHit[];
  /** どのクエリのサジェストから出たか（根拠。表示用） */
  hits: string[];
  /** SERP 要塞度（scout が判定したら入る） */
  serpGrade: 'A' | 'B' | 'C' | '';
  serpNote: string;
  /** 人の判定。add-keywords.ts は win / hold だけ入れる */
  verdict: 'win' | 'hold' | 'drop' | '';
  note: string;
}

/** 候補ファイルの外枠。 */
export interface KwCandidateFile {
  generated_at: string;
  axis: AxisSlug | '';
  seeds: string[];
  candidates: KwCandidate[];
}

/* ────────────────────────────────────────────────
 * サジェスト展開の生データ（demand.ts の入力）
 * ──────────────────────────────────────────────── */

export interface SuggestQuery {
  /** 実際に補完APIへ投げた文字列 */
  q: string;
  /** seed … 種KWそのまま／expand … 種KW＋1文字 */
  kind: 'seed' | 'expand';
  seed: string;
  /** 返ってきたサジェスト（順位順） */
  results: string[];
}

export interface SuggestRun {
  queries: SuggestQuery[];
}

/* ────────────────────────────────────────────────
 * 内部リンク
 * ──────────────────────────────────────────────── */

export interface LinkGraph {
  /** slug → 本文からリンクしている先の slug */
  out: Map<string, Set<string>>;
  /** slug → この記事へリンクしている元の slug */
  in: Map<string, Set<string>>;
}

export interface LinkSuggestion {
  /** リンクを置く側 */
  from: { slug: string; title: string; axis: string };
  /** リンク先 */
  to: { slug: string; title: string; keyword: string; axis: string };
  /** 0〜1。高いほど「その段落はその記事の話をしている」 */
  score: number;
  /** from の本文で、to のKWに触れている段落（先頭 120 字程度） */
  excerpt: string;
  /** その段落の行（0始まり。エディタで飛ぶ用） */
  line: number;
  reason: string;
}

/* ────────────────────────────────────────────────
 * 競合の観測（schema.sql の competitor_* と対）
 * ──────────────────────────────────────────────── */

/** `記事管理/競合/targets.json` の形。人が編集するのはこれだけ。scripts が D1 に写す。 */
export interface CompetitorTargets {
  accounts: Array<{
    handle: string;
    label?: string;
    kind?: CompetitorKind;
    active?: boolean;
    note?: string;
  }>;
  sites: Array<{
    host: string;
    label?: string;
    adapter: 'wp-rest' | 'sitemap' | 'html';
    entry: string;
    active?: boolean;
    note?: string;
  }>;
  /** Hashtag Search（App Review 後にだけ動く）。それまでは無視される */
  hashtags?: string[];
}

/** SNS戦略.md 3章の3タイプ＋同業。分析で「どの型か」を分けて見る */
export type CompetitorKind = 'couple_media' | 'gift_media' | 'vendor' | 'concierge' | 'other';

export interface CompetitorAccount {
  id: number;
  platform: string;
  handle: string;
  label: string;
  kind: CompetitorKind | '';
  active: number;
  followers: number | null;
  media_count: number | null;
  fetched_at: string;
  note: string;
}

export interface CompetitorPost {
  id: string;
  account_id: number;
  media_type: string;
  caption: string;
  permalink: string;
  posted_at: string;
  like_count: number | null;
  comments_count: number | null;
  view_count: number | null;
  source: 'api' | 'hashtag' | 'manual';
  first_seen: string;
  fetched_at: string;
}

export interface CompetitorPostStat {
  post_id: string;
  ymd: string;
  like_count: number | null;
  comments_count: number | null;
  view_count: number | null;
}

export interface CompetitorSite {
  id: number;
  host: string;
  label: string;
  adapter: string;
  entry: string;
  active: number;
  fetched_at: string;
  note: string;
}

export interface CompetitorPage {
  url: string;
  site_id: number;
  title: string;
  published_at: string;
  modified_at: string;
  first_seen: string;
  last_seen: string;
  traffic: number | null;
  top_keyword: string;
  traffic_at: string;
}

/**
 * 投稿1本の評価（src/lib/seo/competitor.ts）。
 * ratio … 同じアカウント内の中央値に対する倍率（フォロワー数の差を消す。SNS戦略.md 4章
 *         「同じアカウントでいいねが13〜118と9倍ひらく。差は題材だけ」）
 * pattern … 勝ちパターン6則（SNS戦略.md 4章）のうち、キャプションから機械で見える項目の当たり
 */
export interface PostScore {
  post: CompetitorPost;
  account: CompetitorAccount;
  engagement: number;
  /** アカウント内の中央値。投稿が3本未満なら null */
  median: number | null;
  ratio: number | null;
  /** 前回取得からの伸び（like の差）。前回が無ければ null */
  delta: number | null;
  pattern: {
    /** 「彼氏に」「彼女へ」「20代」のように相手・状況が明示されている */
    audience: boolean;
    /** 「7選」「35選」「5つ」のような数字 */
    number: boolean;
    /** 1行目がプロフィール誘導（@handle ◀ …） */
    profileCta: boolean;
    /** Anniv の独壇場（規則6）に触れている：店・締切・予算の内訳・段取り */
    annivTerritory: boolean;
  };
  /** 1行目（フック） */
  hook: string;
}

/* ────────────────────────────────────────────────
 * SERP 要塞度
 * ──────────────────────────────────────────────── */

/**
 * 上位10の顔ぶれの分類。keyword-selection.md 2章の表と対。
 *   ec       … EC・ギフトモール（TANP・ギフトモール・anny …）。予約在庫や商品DBで勝つ相手
 *   booking  … 予約DB・グルメサイト（OZmall・一休・食べログ …）。同上
 *   affiliate… ランキング・比較まとめ（mybest・価格.com …）
 *   owned    … 事業会社の自社メディア（自分たちと同じ立場）
 *   official … ブランド・ホテル・店舗の公式、官公庁
 *   personal … 個人ブログ・Q&A（知恵袋・note …）
 *   social   … SNS・動画
 *   unknown  … 判別できない
 */
export type SerpClass = 'ec' | 'booking' | 'affiliate' | 'owned' | 'official' | 'personal' | 'social' | 'unknown';

export type SerpGrade = 'A' | 'B' | 'C';

export interface SerpVerdict {
  grade: SerpGrade;
  /** 分類ごとの件数 */
  counts: Record<SerpClass, number>;
  reason: string;
}
