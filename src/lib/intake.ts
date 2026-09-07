/**
 * フォームの定義と検証。**フォームの SSOT。**
 *
 * 設問・選択肢はここだけに書き、画面（apply.astro / survey.astro）はこれを描画し、
 * 受け口（api/apply.ts / api/survey.ts）はこれで検証する。片方だけ直すと
 * 「画面には出るのに保存で弾かれる」が起きるので、選択肢を増やすときは必ずここ。
 *
 * **申し込みは2段階に分けてある**（2026-09-07）。
 *
 *   1. `/apply` … お名前・メール・LINE名 の3つだけ（`parseIntake`）
 *   2. `/survey` … 記念日・予算・パートナーの好みなど（`parseSurvey`）
 *
 * 以前は入口で15問すべてを聞いていたが、**答え切る前に離脱するほうが損が大きい**。
 * まず連絡が取れる状態を作り、詳しいことは友だち追加のあと LINE から案内する。
 * 2段目は必須を3つ（記念日・日付・予算）に絞ってあり、残りは分かる範囲でよい。
 *
 * 興味の一覧は仕様書5章の50項目。ステータスなど案件の管理用の定数もここに置く
 * （schema.sql の cases と対）。
 */

/* ── 設問の選択肢 ── */

export const INTEREST_GROUPS = [
  {
    label: 'エンタメ・カルチャー',
    items: [
      'ディズニー', 'K-POP・韓国アイドル', 'アニメ・マンガ', '映画鑑賞', 'ドラマ（国内）',
      'ドラマ（海外・韓国）', '音楽ライブ・フェス', '舞台・ミュージカル', '推し活（アイドル・俳優）', 'ゲーム',
    ],
  },
  {
    label: 'ファッション・ビューティー',
    items: [
      'ブランドファッション', 'プチプラ・トレンドファッション', '古着・ヴィンテージ', 'アクセサリー・ジュエリー',
      'バッグ・財布', 'コスメ・メイク', 'スキンケア', 'ネイル', 'ヘアケア・ヘアアレンジ', 'エステ・サロン',
      '香水・フレグランス',
    ],
  },
  {
    label: 'フード・グルメ',
    items: [
      'カフェ巡り', 'スイーツ・お菓子', 'グルメ・食べ歩き', '料理・お菓子作り', 'ワイン・お酒',
      'ヘルシーフード', '韓国料理', 'パン・ベーカリー',
    ],
  },
  {
    label: 'アウトドア・アクティビティ',
    items: [
      '旅行（国内）', '旅行（海外）', 'キャンプ・アウトドア', 'スポーツ観戦', '運動・スポーツ全般',
      '海・マリンスポーツ', '登山・ハイキング', '映えスポット巡り',
    ],
  },
  {
    label: 'ライフスタイル・趣味',
    items: [
      'ヨガ・ピラティス', 'ランニング・ウォーキング', '読書', '写真・カメラ', 'アート・美術館',
      'インテリア・部屋づくり', 'ハンドメイド・DIY', 'ガーデニング・植物', '占い・スピリチュアル', 'ペット',
      'SNS・インフルエンサー', 'サウナ・温泉',
    ],
  },
] as const;

const ALL_INTERESTS = new Set<string>(INTEREST_GROUPS.flatMap((g) => [...g.items]));

export const RELATIONSHIP_OPTIONS = ['〜3ヶ月', '〜1年', '〜3年', '3年以上'] as const;
export const ANNIVERSARY_OPTIONS = ['誕生日', '交際記念日', '結婚記念日', 'プロポーズ', 'その他'] as const;
export const BUDGET_OPTIONS = [
  '〜1万円', '1〜2万円', '2〜3万円', '3〜5万円', '5〜10万円', '10万円以上', '未定・相談したい',
] as const;
export const EXPRESS_OPTIONS = [
  { value: '0', label: '通常（1週間前まで）' },
  { value: '1', label: 'スピード対応（2日前まで・+¥3,000〜5,000）' },
] as const;
export const DELEGATION_OPTIONS = [
  { value: '100', label: '100％（プランナーにお任せ）' },
  { value: '70', label: '70％（提案をもとに決めたい）' },
  { value: '30', label: '30％（必要なところだけ頼りたい）' },
] as const;
export const PAST_STYLE_OPTIONS = ['外食', '家でまったり', '特になし', 'その他'] as const;

/* ── 案件の管理用定数（schema.sql の cases と対） ── */

export const CASE_KINDS = [
  { value: 'apply', label: '申込' },
  { value: 'consult', label: '無料相談' },
] as const;
export type CaseKind = (typeof CASE_KINDS)[number]['value'];

export const CASE_STATUSES = [
  { value: 'new', label: '新規', hint: '受付直後。まだ連絡していない' },
  { value: 'contacted', label: '連絡済み', hint: 'LINE で初回連絡した' },
  { value: 'hearing', label: 'ヒアリング中', hint: 'LINE で追加ヒアリング中' },
  { value: 'proposed', label: '提案済み', hint: 'プランと見積を出した' },
  { value: 'invoiced', label: '請求送付済み', hint: 'Stripe の Invoice URL を送った' },
  { value: 'paid', label: '入金済み', hint: '手配に入れる' },
  { value: 'arranging', label: '手配中', hint: 'プレゼント発注・レストラン予約' },
  { value: 'delivered', label: '納品済み', hint: '演出指示書を送った' },
  { value: 'followed', label: '完了', hint: '記念日翌日のフォローまで済んだ' },
  { value: 'lost', label: '失注・取消', hint: '返信なし・キャンセル' },
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number]['value'];

/** 進行中とみなさないステータス（一覧の既定フィルタ「進行中」から外れる）。 */
export const CLOSED_STATUSES: readonly CaseStatus[] = ['followed', 'lost'];

export const PAYMENT_STATUSES = [
  { value: 'none', label: '未請求' },
  { value: 'sent', label: '請求送付済み' },
  { value: 'paid', label: '入金済み' },
  { value: 'refunded', label: '返金済み' },
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]['value'];

export const PAYMENT_METHODS = [
  { value: 'stripe', label: 'Stripe（カード）' },
  { value: 'paypay', label: 'PayPay' },
  { value: 'bank', label: '銀行振込' },
  { value: 'other', label: 'その他' },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['value'];

export function isCaseKind(v: unknown): v is CaseKind {
  return typeof v === 'string' && CASE_KINDS.some((k) => k.value === v);
}
export function isCaseStatus(v: unknown): v is CaseStatus {
  return typeof v === 'string' && CASE_STATUSES.some((s) => s.value === v);
}
export function isPaymentStatus(v: unknown): v is PaymentStatus {
  return typeof v === 'string' && PAYMENT_STATUSES.some((s) => s.value === v);
}
export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === 'string' && PAYMENT_METHODS.some((s) => s.value === v);
}
export function statusLabel(v: string): string {
  return CASE_STATUSES.find((s) => s.value === v)?.label ?? v;
}
export function kindLabel(v: string): string {
  return CASE_KINDS.find((k) => k.value === v)?.label ?? v;
}

/* ── 検証 ── */

/**
 * 入口のフォーム（`/apply`）。**3つしか聞かない。**
 *
 * 以前はここで15問すべてを聞いていたが、答え切る前に離脱するほうが損が大きい。
 * 連絡が取れる状態（LINEで見つけられる状態）を先に作り、
 * 詳しいことは友だち追加のあと `/survey` で聞く（`受注フロー.md` 2章）。
 *
 * `line_name` を聞くのは、**LINEの表示名と申込を突き合わせる手がかりになる**ため。
 * 名前とメールだけだと、友だち追加した人が誰なのか運営者側から判別しづらい。
 */
export interface ApplyInput {
  kind: 'apply';
  name: string;
  email: string;
  line_name: string;
}

/**
 * 友だち追加後に答えてもらう詳しいアンケート（`/survey`）。
 * 既にある案件を**更新する**ので、どの案件かを特定する手段（受付番号かメール）を別に受け取る。
 */
export interface SurveyInput {
  phone: string;
  age: string;
  partner_age: string;
  relationship: string;
  anniversary: string;
  anniversary_date: string;
  budget: string;
  express: 0 | 1;
  delegation: string;
  interests: string[];
  past_style: string;
  wishes: string;
}

export interface ConsultInput {
  kind: 'consult';
  name: string;
  email: string;
  anniversary: string;
  anniversary_date: string;
  message: string;
}

export type IntakeInput = ApplyInput | ConsultInput;

export type ParseResult =
  | { ok: true; value: IntakeInput }
  | { ok: false; spam?: false; errors: Record<string, string> }
  /** ハニーポットに値が入っていた。呼び出し側は成功したふりをして何も保存しない。 */
  | { ok: false; spam: true; errors: Record<string, string> };

/**
 * FormData を検証用のレコードに落とす。
 * `interests` だけ複数値（チェックボックス）なので getAll で配列にする。
 * JSON で来た場合はそのまま渡せる（配列は配列のまま）。
 */
export function formDataToRecord(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(fd.keys())) {
    const all = fd.getAll(key).filter((v): v is string => typeof v === 'string');
    out[key] = key === 'interests' ? all : (all[0] ?? '');
  }
  return out;
}

/** 制御文字（改行・タブ以外）を落とす。NUL を含むので正規表現は文字列から組む。 */
const CONTROL_RE = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', 'g');

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // 全角スペースは通常の空白扱いで trim する。
  return v
    .replace(CONTROL_RE, '')
    .replace(/^[\s　]+|[\s　]+$/g, '')
    .slice(0, max);
}

function oneOf<T extends readonly string[]>(v: string, list: T): v is T[number] {
  return (list as readonly string[]).includes(v);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePhone(v: string): string {
  // 全角数字・記号を半角に寄せ、数字と + と - 以外を落とす
  const half = v
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ー－―]/g, '-');
  return half.replace(/[^\d+\-]/g, '');
}

function normalizeDate(v: string): string | null {
  const s = v.trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 申込・無料相談の入力を検証して正規化する。
 * `kind` が無い／不正なら apply として扱う（LP から来るのは申込フォームのため）。
 */
export function parseIntake(raw: Record<string, unknown>): ParseResult {
  const errors: Record<string, string> = {};

  // ハニーポット。人間には見えない欄に値が入っていたら bot。
  if (str(raw.website, 10) !== '') {
    return { ok: false, spam: true, errors: { website: 'spam' } };
  }

  const kind: CaseKind = raw.kind === 'consult' ? 'consult' : 'apply';

  const name = str(raw.name, 60);
  if (!name) errors.name = 'お名前を入力してください';

  const email = str(raw.email, 200).toLowerCase();
  if (!email) errors.email = 'メールアドレスを入力してください';
  else if (!EMAIL_RE.test(email)) errors.email = 'メールアドレスの形式が正しくありません';

  if (kind === 'consult') {
    // 無料相談は「何を聞きたいか」が本体。記念日の情報は任意で受け取る。
    const annRaw = str(raw.anniversary, 40);
    const annOther = str(raw.anniversary_other, 100);
    const anniversary = annRaw === 'その他' ? (annOther ? `その他：${annOther}` : 'その他') : annRaw;

    const dateRaw = str(raw.anniversary_date, 20);
    const anniversary_date = dateRaw ? normalizeDate(dateRaw) : '';
    if (dateRaw && anniversary_date === null) errors.anniversary_date = '日付の形式が正しくありません';

    const message = str(raw.message, 2000);
    if (!message) errors.message = 'ご相談内容を入力してください';
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      value: { kind: 'consult', name, email, anniversary, anniversary_date: anniversary_date ?? '', message },
    };
  }

  // 申し込みの入口はここまで。**3つしか聞かない**（詳しいことは /survey）。
  const line_name = str(raw.line_name, 60);
  if (!line_name) errors.line_name = 'LINE のお名前を入力してください';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { kind: 'apply', name, email, line_name } };
}

/* ── 詳しいアンケート（/survey）── */

export type SurveyResult =
  | { ok: true; value: SurveyInput }
  | { ok: false; spam?: false; errors: Record<string, string> }
  | { ok: false; spam: true; errors: Record<string, string> };

/**
 * 友だち追加後のアンケートの検証。
 *
 * **必須にするのは記念日・日付・予算だけ**にしてある。ここまで来た人には既に連絡が取れるので、
 * 全部埋めさせるより「分かる範囲で送ってもらう」ほうが返ってくる。
 * 足りないところは LINE のトークで人が聞けばいい。
 */
export function parseSurvey(raw: Record<string, unknown>): SurveyResult {
  const errors: Record<string, string> = {};

  if (str(raw.website, 10) !== '') {
    return { ok: false, spam: true, errors: { website: 'spam' } };
  }

  const annRaw = str(raw.anniversary, 40);
  const annOther = str(raw.anniversary_other, 100);
  const anniversary = annRaw === 'その他' ? (annOther ? `その他：${annOther}` : 'その他') : annRaw;
  if (!annRaw) errors.anniversary = '記念日の内容を選んでください';
  else if (annRaw !== 'その他' && !oneOf(annRaw, ANNIVERSARY_OPTIONS)) errors.anniversary = '記念日の内容を選んでください';
  else if (annRaw === 'その他' && !annOther) errors.anniversary_other = '記念日の内容を入力してください';

  const dateRaw = str(raw.anniversary_date, 20);
  const anniversary_date = dateRaw ? normalizeDate(dateRaw) : '';
  if (!dateRaw) errors.anniversary_date = '記念日の日付を入力してください';
  else if (anniversary_date === null) errors.anniversary_date = '日付の形式が正しくありません';

  const budget = str(raw.budget, 40);
  if (!oneOf(budget, BUDGET_OPTIONS)) errors.budget = 'ご予算を選んでください';

  // ここから下は任意。空なら空のまま保存する（未回答と区別する必要がない）。
  const phoneRaw = str(raw.phone, 30);
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  if (phone && phone.replace(/\D/g, '').length < 10) errors.phone = '電話番号の桁数が足りません';

  const age = str(raw.age, 10);
  const partner_age = str(raw.partner_age, 10);

  const relationship = str(raw.relationship, 20);
  if (relationship && !oneOf(relationship, RELATIONSHIP_OPTIONS)) errors.relationship = '交際期間の値が不正です';

  const expressRaw = str(raw.express, 2);
  const express: 0 | 1 = expressRaw === '1' ? 1 : 0;

  const delegation = str(raw.delegation, 4);
  if (delegation && !DELEGATION_OPTIONS.some((d) => d.value === delegation)) errors.delegation = 'お任せ度合いの値が不正です';

  const interestsRaw = Array.isArray(raw.interests)
    ? raw.interests
    : typeof raw.interests === 'string' && raw.interests
      ? [raw.interests]
      : [];
  const interests = Array.from(
    new Set(interestsRaw.filter((v): v is string => typeof v === 'string' && ALL_INTERESTS.has(v))),
  ).slice(0, 60);
  const interestsOther = str(raw.interests_other, 200);
  if (interestsOther) interests.push(`その他：${interestsOther}`);

  const past_style = str(raw.past_style, 20);
  if (past_style && !oneOf(past_style, PAST_STYLE_OPTIONS)) errors.past_style = 'これまでの過ごし方の値が不正です';

  const wishes = str(raw.wishes, 1000);

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      phone,
      age,
      partner_age,
      relationship,
      anniversary,
      anniversary_date: anniversary_date ?? '',
      budget,
      express,
      delegation,
      interests,
      past_style,
      wishes,
    },
  };
}

/* ── 流入元（track.js が sessionStorage に持つ UTM をフォームの hidden で受ける） ── */

const ALLOWED_SOURCES = new Set([
  'instagram', 'x', 'tiktok', 'line', 'meta_ads', 'google', 'yahoo', 'bing', 'other', 'direct',
]);

function slug(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);
}

/** /api/ev と同じ規則で流入元を正規化する（値の集合を揃えて /dashboard と突き合わせられるように）。 */
export function parseAttribution(raw: Record<string, unknown>): { source: string; medium: string; campaign: string } {
  const s = slug(raw._source, 16);
  return {
    source: !s ? 'direct' : ALLOWED_SOURCES.has(s) ? s : 'other',
    medium: slug(raw._medium, 16),
    campaign: slug(raw._campaign, 32),
  };
}
