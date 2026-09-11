/**
 * 案件（cases / case_log）への D1 アクセス。スキーマは schema.sql が正。
 *
 * 顧客の情報と案件の進行を1テーブルで持つ。書き込みの入口は 3 つだけ：
 *   - createCase   … /api/apply（申込・無料相談の受付）
 *   - updateCase   … /api/cases/[id]（管理画面の PATCH。列は PATCHABLE_FIELDS に閉じる）
 *   - linkLineUser … LINE Webhook（受付番号の受信）と管理画面の手動紐づけ
 */
import { db } from './db';
import {
  CLOSED_STATUSES,
  isCaseStatus,
  isPaymentMethod,
  isPaymentStatus,
  type CaseKind,
  type CaseStatus,
  type IntakeInput,
  type SurveyInput,
} from './intake';

export interface CaseRow {
  id: number;
  code: string;
  kind: CaseKind;
  status: CaseStatus;
  name: string;
  email: string;
  phone: string;
  line_name: string;
  line_user_id: string | null;
  age: string;
  partner_age: string;
  relationship: string;
  anniversary: string;
  anniversary_date: string;
  budget: string;
  express: number;
  delegation: string;
  interests_json: string;
  past_style: string;
  wishes: string;
  message: string;
  submission_json: string;
  source: string;
  medium: string;
  campaign: string;
  plan: string;
  gift: string;
  gift_arranged: number;
  gift_shipped_on: string;
  restaurant: string;
  restaurant_booked: number;
  guide_sent: number;
  payment_method: string;
  payment_status: string;
  amount: number;
  stripe_invoice_id: string;
  memo: string;
  /** アンケート（/survey）に答えた日時。**null なら未回答**。 */
  survey_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 一覧用。本文系の列は引かず、LINE の表示名だけ JOIN で足す。 */
export interface CaseListItem {
  id: number;
  code: string;
  kind: CaseKind;
  status: CaseStatus;
  name: string;
  email: string;
  line_name: string;
  line_user_id: string | null;
  line_display_name: string | null;
  anniversary: string;
  anniversary_date: string;
  express: number;
  budget: string;
  amount: number;
  payment_status: string;
  source: string;
  /** アンケート（/survey）に答えた日時。**null なら未回答**＝まだ提案に必要な情報が揃っていない */
  survey_at: string | null;
  created_at: string;
  updated_at: string;
}

const LIST_COLS = `c.id, c.code, c.kind, c.status, c.name, c.email, c.line_name, c.line_user_id,
  u.display_name AS line_display_name, c.anniversary, c.anniversary_date, c.express, c.budget,
  c.amount, c.payment_status, c.source, c.survey_at, c.created_at, c.updated_at`;

export interface CaseLogRow {
  id: number;
  case_id: number;
  kind: string;
  body: string;
  created_at: string;
}

/* ── 受付番号 ── */

/** 0/O、1/I/L のような見間違えやすい字を除いた 31 文字。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i === 3) s += '-';
  }
  return s;
}

/**
 * 自由文から受付番号を抜き出す（LINE で送られてきたメッセージ用）。
 * 全角英数は半角に寄せ、大文字化し、ハイフンの揺れ（ー・－・空白）も吸収する。
 * 見つからなければ null。
 */
export function extractCode(text: string): string | null {
  // URL は見ない。Instagram の投稿URL（instagram.com/p/DAbCdEfGhIj/）のような文字列が
  // 8桁の英数として拾われてしまい、リンクを送ってきた顧客に bot が
  // 「受付番号が見つかりません」と割り込む。顧客はリンクを普通に送ってくる。
  if (/https?:\/\//i.test(text)) return null;

  const half = text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .replace(/[ー－―‐]/g, '-');
  /*
    文中から拾うときは**区切り（ハイフンか空白）を必須**にする。連続8文字を無条件で拾うと
    型番や英単語に当たる。ただしメッセージが番号だけのとき（`K7M24QXA` と打っただけ）は
    区切り無しでも受ける——手で打ち写す人はハイフンを省きやすいため。
  */
  const bare = half.replace(/[\s-]/g, '');
  const m =
    /^[A-Z0-9]{8}$/.test(bare) && half.trim().length <= 10
      ? ([, bare.slice(0, 4), bare.slice(4)] as unknown as RegExpMatchArray)
      : half.match(/([A-Z0-9]{4})[-\s]([A-Z0-9]{4})/);
  if (!m) return null;
  const code = `${m[1]}-${m[2]}`;
  // 受付番号の字種に合わないもの（0/O/1/I/L を含む）は番号ではない
  for (const ch of code.replace('-', '')) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/* ── 作成 ── */

export interface CreateCaseExtra {
  /** 生の回答（そのまま JSON で保存する。20KB で切る） */
  submission: unknown;
  source: string;
  medium: string;
  campaign: string;
  /**
   * 履歴の最初の1行。省略すると入口の種類から決める。
   * フォーム以外の経路（LINE のアンケートから作る場合など）で「申込フォームから受付」と
   * 残ると、あとで履歴を読んだときに経路を取り違えるので、呼び出し側から言えるようにしてある。
   */
  logBody?: string;
}

export async function createCase(input: IntakeInput, extra: CreateCaseExtra): Promise<CaseRow> {
  const now = new Date().toISOString();
  let submission = '{}';
  try {
    submission = JSON.stringify(extra.submission ?? {}).slice(0, 20_000);
  } catch {
    submission = '{}';
  }

  const consult = input.kind === 'consult' ? input : null;

  // code の UNIQUE 衝突は 31^8 分の1なのでまず起きないが、起きたら引き直す。
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      const res = await db()
        .prepare(
          `INSERT INTO cases
           (code, kind, status, name, email, line_name, anniversary, anniversary_date,
            message, submission_json, source, medium, campaign, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          code,
          input.kind,
          'new',
          input.name,
          input.email,
          input.kind === 'apply' ? input.line_name : '',
          consult?.anniversary ?? '',
          consult?.anniversary_date ?? '',
          consult?.message ?? '',
          submission,
          extra.source,
          extra.medium,
          extra.campaign,
          now,
          now,
        )
        .run();
      const id = Number(res.meta.last_row_id);
      await addCaseLog(
        id,
        'created',
        extra.logBody ??
          (input.kind === 'apply' ? '申込フォームから受付（アンケートは未回答）' : '無料相談フォームから受付'),
      );
      const row = await getCase(id);
      if (!row) throw new Error('作成直後の案件が読めない');
      return row;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE/i.test(msg) && attempt < 2) continue;
      throw e;
    }
  }
  throw new Error('受付番号の生成に失敗');
}

/**
 * 詳しいアンケート（/survey）の回答を既存の案件に書き戻す。
 *
 * **入口のフォームで作った行を更新するだけ**で、新しい案件は作らない。
 * answered が2回目以降でも上書きする（言い直したくなることがあるため）。
 * 回答済みかどうかは `survey_at` の有無で判定する。
 */
export async function applySurvey(
  caseId: number,
  s: SurveyInput,
  rawSubmission?: unknown,
): Promise<CaseRow | null> {
  const now = new Date().toISOString();
  const before = await getCase(caseId);
  if (!before) return null;

  /*
    **空欄で既存の回答を上書きしない。**

    アンケートは必須3つ以外を任意にしてあるので、2回目に「日付だけ直したい」で開くと
    残りが空のまま送られてくる。素直に UPDATE すると、前回答えてくれた電話・年齢・興味・
    希望こだわりが全部消える。消えたことは case_log にも残らず復元もできない。
    そこで**入力があった項目だけ**を書き、空欄は前の値を残す。
    消したいときは管理画面（/admin/cases/<id>）から直接編集する。
  */
  const keep = (next: string, prev: string): string => (next === '' ? prev : next);
  const interests = s.interests.length > 0 ? JSON.stringify(s.interests) : before.interests_json;

  // 生の回答も残す。設問を増やしたときに、まだ列が無くても値が失われないようにするため
  // （入口の回答は submission_json に入っているので、アンケートは survey キーの下にぶら下げる）。
  let submission = before.submission_json;
  if (rawSubmission !== undefined) {
    try {
      const base = JSON.parse(before.submission_json || '{}') as Record<string, unknown>;
      base.survey = rawSubmission;
      submission = JSON.stringify(base).slice(0, 20_000);
    } catch {
      submission = before.submission_json;
    }
  }

  await db()
    .prepare(
      `UPDATE cases SET
         phone=?, age=?, partner_age=?, relationship=?, anniversary=?, anniversary_date=?,
         budget=?, express=?, delegation=?, interests_json=?, past_style=?, wishes=?,
         submission_json=?, survey_at=?, updated_at=?
       WHERE id=?`,
    )
    .bind(
      keep(s.phone, before.phone),
      keep(s.age, before.age),
      keep(s.partner_age, before.partner_age),
      keep(s.relationship, before.relationship),
      // 記念日・日付・予算は必須なので常に値が入る（空で来ることはない）
      s.anniversary,
      s.anniversary_date,
      s.budget,
      s.express,
      keep(s.delegation, before.delegation),
      interests,
      keep(s.past_style, before.past_style),
      keep(s.wishes, before.wishes),
      submission,
      now,
      now,
      caseId,
    )
    .run();

  await addCaseLog(caseId, 'survey', before.survey_at ? 'アンケートの再回答' : 'アンケートに回答');
  return await getCase(caseId);
}

/**
 * メールアドレスから案件を1件引く（アンケートの照合用）。
 *
 * LINE のあいさつメッセージから開いた `/survey` は受付番号を持っていないので、
 * **申し込み時に入れたメールで本人を特定する**。同じメールで複数あれば新しいほうを採る
 * （リピートのとき、古い案件を上書きしないため）。
 */
export async function findCaseByEmail(email: string): Promise<CaseRow | null> {
  return await db()
    .prepare('SELECT * FROM cases WHERE email=? ORDER BY id DESC LIMIT 1')
    .bind(email.trim().toLowerCase())
    .first<CaseRow>();
}

/* ── 取得 ── */

export async function getCase(id: number): Promise<CaseRow | null> {
  return await db().prepare('SELECT * FROM cases WHERE id=?').bind(id).first<CaseRow>();
}

export async function getCaseByCode(code: string): Promise<CaseRow | null> {
  return await db().prepare('SELECT * FROM cases WHERE code=?').bind(code).first<CaseRow>();
}

export async function findCaseByLineUser(userId: string): Promise<CaseRow | null> {
  return await db()
    .prepare('SELECT * FROM cases WHERE line_user_id=? ORDER BY id DESC LIMIT 1')
    .bind(userId)
    .first<CaseRow>();
}

export interface CaseListFilter {
  /** 'open'（既定）＝ CLOSED_STATUSES 以外、'all'＝全部、それ以外は個別のステータス */
  status?: CaseStatus | 'open' | 'all';
  kind?: CaseKind;
  /** 名前・メール・受付番号・LINE名の部分一致 */
  q?: string;
  limit?: number;
}

export async function listCases(filter: CaseListFilter = {}): Promise<CaseListItem[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = filter.status ?? 'open';
  if (status === 'open') {
    where.push(`c.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`);
    binds.push(...CLOSED_STATUSES);
  } else if (status !== 'all' && isCaseStatus(status)) {
    where.push('c.status=?');
    binds.push(status);
  }
  if (filter.kind) {
    where.push('c.kind=?');
    binds.push(filter.kind);
  }
  const q = (filter.q ?? '').trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.code LIKE ? OR c.line_name LIKE ? OR u.display_name LIKE ?)');
    binds.push(like, like, like.toUpperCase(), like, like);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const sql = `SELECT ${LIST_COLS} FROM cases c LEFT JOIN line_users u ON u.user_id = c.line_user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ?`;
  const { results } = await db()
    .prepare(sql)
    .bind(...binds, limit)
    .all<CaseListItem>();
  return results ?? [];
}

export async function countCasesByStatus(): Promise<Record<string, number>> {
  const { results } = await db()
    .prepare('SELECT status, COUNT(*) AS n FROM cases GROUP BY status')
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.status] = r.n;
  return out;
}

const JST_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' });

/** 記念日が近い進行中の案件（今日から days 日以内。過ぎたものは出さない）。 */
export async function listUpcoming(days = 14): Promise<CaseListItem[]> {
  const today = JST_YMD.format(new Date());
  const untilYmd = JST_YMD.format(new Date(Date.now() + days * 86_400_000));
  const { results } = await db()
    .prepare(
      `SELECT ${LIST_COLS} FROM cases c LEFT JOIN line_users u ON u.user_id = c.line_user_id
       WHERE c.anniversary_date >= ? AND c.anniversary_date <= ?
         AND c.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})
       ORDER BY c.anniversary_date ASC, c.id ASC`,
    )
    .bind(today, untilYmd, ...CLOSED_STATUSES)
    .all<CaseListItem>();
  return results ?? [];
}

/* ── 回答の集計（/admin/cases/insights） ── */

/**
 * 集計に使う列だけを引く。
 *
 * 「どの予算帯が多いか」「パートナーの興味は何が多いか」を見て、
 * 記事のテーマ選びとプレゼントの仕入れ判断に使う。**申し込みの回答は
 * 検索KWより実需に近い**ので、メディアのKW台帳とは別の情報として持つ価値がある。
 *
 * 集計はSQLではなくJSでやる。件数が三桁までは1クエリで全部引いて畳むほうが速く、
 * 項目を増やすたびにクエリを足さずに済む（D1はクエリ数が効くので束ねたい）。
 */
export interface AnswerRow {
  id: number;
  kind: CaseKind;
  status: CaseStatus;
  anniversary: string;
  anniversary_date: string;
  relationship: string;
  budget: string;
  express: number;
  delegation: string;
  past_style: string;
  age: string;
  partner_age: string;
  interests_json: string;
  wishes: string;
  message: string;
  source: string;
  medium: string;
  campaign: string;
  created_at: string;
}

const ANSWER_COLS = `id, kind, status, anniversary, anniversary_date, relationship, budget, express,
  delegation, past_style, age, partner_age, interests_json, wishes, message, source, medium, campaign, created_at`;

/** `sinceIso` を渡すとその日時以降の申し込みだけ。失注も含める（傾向を見るのが目的なので）。 */
export async function listAnswers(sinceIso?: string): Promise<AnswerRow[]> {
  const sql = sinceIso
    ? `SELECT ${ANSWER_COLS} FROM cases WHERE created_at >= ? ORDER BY created_at DESC`
    : `SELECT ${ANSWER_COLS} FROM cases ORDER BY created_at DESC`;
  const stmt = sinceIso ? db().prepare(sql).bind(sinceIso) : db().prepare(sql);
  const { results } = await stmt.all<AnswerRow>();
  return results ?? [];
}

export interface Bucket {
  value: string;
  count: number;
  /** 0〜100。母数は「その設問に答えている件数」 */
  pct: number;
}

/**
 * 値ごとの件数を数える。空文字は母数から外す（無料相談は申込側の設問を持たないため、
 * 混ぜると全部の割合が小さく出て読み違える）。
 *
 * `order` を渡すとその並びで返す（選択肢の定義順に出したいとき）。
 * 渡さなければ件数の多い順。`order` にあって0件の値も行として残す——
 * 「誰も選んでいない選択肢」も判断材料になるため。
 */
export function countBy(values: string[], order?: readonly string[]): Bucket[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    total++;
  }
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  if (order) {
    const known = order.map((value) => ({ value, count: counts.get(value) ?? 0 }));
    // 定義に無い値（「その他：…」など）は後ろに件数順で足す
    const extra = [...counts.entries()]
      .filter(([v]) => !order.includes(v))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    return [...known, ...extra].map((r) => ({ ...r, pct: pct(r.count) }));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count, pct: pct(count) }));
}

/** 興味（配列）の集計。母数は「1つ以上選んだ人の数」なので合計は100%を超える。 */
export function countInterests(rows: AnswerRow[]): { items: Bucket[]; respondents: number } {
  const counts = new Map<string, number>();
  let respondents = 0;
  for (const r of rows) {
    const list = parseInterests(r);
    if (list.length === 0) continue;
    respondents++;
    for (const v of new Set(list)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({
      value,
      count,
      pct: respondents === 0 ? 0 : Math.round((count / respondents) * 1000) / 10,
    }));
  return { items, respondents };
}

/** 年齢を10歳刻みに畳む。数字として読めないものは捨てる。 */
export function countAgeBuckets(values: string[]): Bucket[] {
  const buckets = values
    .map((v) => Number(String(v).replace(/[^\d]/g, '')))
    .filter((n) => Number.isFinite(n) && n >= 10 && n < 100)
    .map((n) => `${Math.floor(n / 10) * 10}代`);
  return countBy(buckets, ['10代', '20代', '30代', '40代', '50代', '60代']);
}

/**
 * 申し込みから記念日までの日数を帯に畳む。**どれくらい前に相談が来るか**が分かると、
 * 仕入れとレストラン予約のリードタイムを決められる。
 */
export function countLeadTime(rows: AnswerRow[]): Bucket[] {
  const labels: string[] = [];
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.anniversary_date)) continue;
    const created = Date.parse(r.created_at);
    if (!Number.isFinite(created)) continue;
    const target = Date.parse(`${r.anniversary_date}T00:00:00+09:00`);
    const days = Math.round((target - created) / 86_400_000);
    if (days < 0) labels.push('過ぎている');
    else if (days <= 2) labels.push('2日以内');
    else if (days <= 7) labels.push('3〜7日');
    else if (days <= 14) labels.push('8〜14日');
    else if (days <= 30) labels.push('15〜30日');
    else labels.push('31日以上');
  }
  return countBy(labels, ['2日以内', '3〜7日', '8〜14日', '15〜30日', '31日以上', '過ぎている']);
}

/* ── LINE の紐づけ候補 ── */

/**
 * 「申し込んだ直後に友だち追加した人」を突き合わせるための候補探し。
 *
 * 受付番号をトークに送ってもらえば確実に紐づくが、**顧客に番号を打たせるのは体験が悪い。**
 * 実際には「申し込む → サンクスページの緑のボタンを押す → 友だち追加」が数十秒で連続するので、
 * 友だち追加の直前に来た未紐づけの申し込みは、ほぼ本人と見てよい。
 *
 * ただし**自動では紐づけない。** Instagram のプロフィールから申し込みと無関係に
 * 友だち追加する人がいて、そのとき「窓の中に未紐づけの案件が1件だけある」と
 * 他人の案件に結びついてしまう。取り違えると別人の記念日プランと個人情報を送ることになるので、
 * 候補として出すところまでにして、最後は人が表示名を見て確定する（/admin/cases）。
 */
export interface LinkCandidate {
  case: CaseListItem;
  /** 申し込みから友だち追加までの分数。負なら友だち追加のほうが先 */
  minutesAfter: number;
}

/** 申し込みから友だち追加までが、これ以内なら候補にする。 */
export const LINK_WINDOW_MINUTES = 90;

/**
 * 友だち追加のほうが先だった場合に、何分後までの申し込みを候補に含めるか（既定7日）。
 * 既に友だちの人が後から申し込む経路を拾うためのもの。詳しくは rankLinkCandidates の中。
 */
export const BEFORE_WINDOW_MINUTES = 7 * 24 * 60;

/**
 * 取得済みの一覧から候補を絞る（DBを引かない）。
 * 追加の直前に申し込んだものを近い順に返す。時計のズレを見込んで、
 * 申し込みが友だち追加の 2 分後までなら候補に含める。
 */
export function rankLinkCandidates(
  followedAtIso: string,
  cases: CaseListItem[],
  windowMinutes = LINK_WINDOW_MINUTES,
): LinkCandidate[] {
  const followed = Date.parse(followedAtIso);
  if (!Number.isFinite(followed)) return [];
  const out: LinkCandidate[] = [];
  for (const c of cases) {
    if (c.line_user_id) continue;
    const created = Date.parse(c.created_at);
    if (!Number.isFinite(created)) continue;
    const minutesAfter = (followed - created) / 60_000;
    /*
      **申し込みが友だち追加より後でも候補にする。**

      Anniv の流入はSNS中心で、「先に Instagram のプロフィールから友だち追加 → 後日
      記事を読んで申し込む」が普通に起きる。LINE は既存の友だちに follow を再送しないので、
      その人には候補通知もアンケート案内も飛ばない。時刻の窓を「追加の直前」に限っていると、
      **後から来た申し込みが候補に一切出てこず、案件が一覧の下に沈む。**
      追加より後ろは BEFORE_WINDOW_MINUTES（既定7日）まで見る。
    */
    if (minutesAfter < -BEFORE_WINDOW_MINUTES || minutesAfter > windowMinutes) continue;
    out.push({ case: c, minutesAfter: Math.round(minutesAfter) });
  }
  return out.sort((a, b) => Math.abs(a.minutesAfter) - Math.abs(b.minutesAfter));
}

/** Webhook の通知文に候補を載せるための版（DBを引く）。 */
export async function findLinkCandidates(
  followedAtIso: string,
  windowMinutes = LINK_WINDOW_MINUTES,
  limit = 3,
): Promise<LinkCandidate[]> {
  const open = await listCases({ status: 'open', limit: 200 });
  return rankLinkCandidates(followedAtIso, open, windowMinutes).slice(0, limit);
}

/* ── 更新 ── */

/**
 * 管理画面から書き換えてよい列。ここに無い列は API が受け取っても捨てる。
 * code / kind / submission_json / line_user_id / created_at は変えない
 * （line_user_id は linkLineUser 経由でだけ変える）。
 */
export const PATCHABLE_FIELDS = [
  'status', 'name', 'email', 'phone', 'line_name', 'anniversary', 'anniversary_date', 'budget',
  'express', 'wishes', 'plan', 'gift', 'gift_arranged', 'gift_shipped_on', 'restaurant',
  'restaurant_booked', 'guide_sent', 'payment_method', 'payment_status', 'amount',
  'stripe_invoice_id', 'memo',
] as const;
export type PatchableField = (typeof PATCHABLE_FIELDS)[number];
export type CasePatch = Partial<Pick<CaseRow, PatchableField>>;

const INT_FIELDS = new Set<PatchableField>([
  'express', 'gift_arranged', 'restaurant_booked', 'guide_sent', 'amount',
]);
const TEXT_MAX: Partial<Record<PatchableField, number>> = {
  name: 60, email: 200, phone: 30, line_name: 60, anniversary: 100, anniversary_date: 10, budget: 40,
  wishes: 1000, plan: 100, gift: 500, gift_shipped_on: 20, restaurant: 200, stripe_invoice_id: 100, memo: 4000,
};

/** 制御文字（改行・タブ以外）。NUL を含むので文字列から組む。 */
const CONTROL_RE = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', 'g');

/**
 * 生の入力（JSON）から安全な patch を作る。
 * 不正な値は「無視」ではなく「エラー」で返す。黙って捨てると保存したつもりの値が消えるため。
 */
export function sanitizePatch(raw: Record<string, unknown>): { patch: CasePatch; errors: string[] } {
  const patch: CasePatch = {};
  const errors: string[] = [];
  for (const key of PATCHABLE_FIELDS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (INT_FIELDS.has(key)) {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
        errors.push(`${key} が数値ではありません`);
        continue;
      }
      (patch as Record<string, unknown>)[key] = key === 'amount' ? Math.round(n) : n ? 1 : 0;
      continue;
    }
    if (typeof v !== 'string') {
      errors.push(`${key} が文字列ではありません`);
      continue;
    }
    const s = v.replace(CONTROL_RE, '').trim();
    if (key === 'status' && !isCaseStatus(s)) {
      errors.push('status の値が不正です');
      continue;
    }
    if (key === 'payment_status' && !isPaymentStatus(s)) {
      errors.push('payment_status の値が不正です');
      continue;
    }
    if (key === 'payment_method' && !isPaymentMethod(s)) {
      errors.push('payment_method の値が不正です');
      continue;
    }
    if (key === 'anniversary_date' && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      errors.push('anniversary_date は YYYY-MM-DD で入れてください');
      continue;
    }
    const max = TEXT_MAX[key] ?? 200;
    (patch as Record<string, unknown>)[key] = s.slice(0, max);
  }
  return { patch, errors };
}

/** patch の列だけ UPDATE する。ステータスが変わったら case_log にも残す。 */
export async function updateCase(id: number, patch: CasePatch): Promise<CaseRow | null> {
  const keys = (Object.keys(patch) as PatchableField[]).filter((k) => PATCHABLE_FIELDS.includes(k));
  const before = await getCase(id);
  if (!before) return null;
  if (keys.length === 0) return before;
  const now = new Date().toISOString();
  const sets = keys.map((k) => `${k}=?`).join(', ');
  const values = keys.map((k) => patch[k]);
  await db()
    .prepare(`UPDATE cases SET ${sets}, updated_at=? WHERE id=?`)
    .bind(...values, now, id)
    .run();
  if (patch.status && patch.status !== before.status) {
    await addCaseLog(id, 'status', `${before.status} → ${patch.status}`);
  }
  return await getCase(id);
}

/* ── 履歴 ── */

export async function addCaseLog(caseId: number, kind: string, body: string): Promise<void> {
  await db()
    .prepare('INSERT INTO case_log (case_id, kind, body, created_at) VALUES (?,?,?,?)')
    .bind(caseId, kind, body.slice(0, 4000), new Date().toISOString())
    .run();
}

export async function listCaseLog(caseId: number, limit = 200): Promise<CaseLogRow[]> {
  const { results } = await db()
    .prepare('SELECT * FROM case_log WHERE case_id=? ORDER BY id DESC LIMIT ?')
    .bind(caseId, limit)
    .all<CaseLogRow>();
  return results ?? [];
}

/* ── LINE との紐づけ ── */

/**
 * 案件に LINE の userId を紐づける。
 * 同じ userId が別の案件に付いていたら外してから付け替える（1人1案件が原則。
 * リピートで2件目が来たら新しい方に寄せる）。
 */
export async function linkLineUser(caseId: number, userId: string, how: string): Promise<void> {
  const now = new Date().toISOString();
  const others = await db()
    .prepare('SELECT id FROM cases WHERE line_user_id=? AND id<>?')
    .bind(userId, caseId)
    .all<{ id: number }>();
  for (const o of others.results ?? []) {
    await db().prepare('UPDATE cases SET line_user_id=NULL, updated_at=? WHERE id=?').bind(now, o.id).run();
    await addCaseLog(o.id, 'unlink', `LINE の紐づけを案件 #${caseId} へ移動`);
  }
  await db().prepare('UPDATE cases SET line_user_id=?, updated_at=? WHERE id=?').bind(userId, now, caseId).run();
  await addCaseLog(caseId, 'link', how);
}

export async function unlinkLineUser(caseId: number): Promise<void> {
  const now = new Date().toISOString();
  await db().prepare('UPDATE cases SET line_user_id=NULL, updated_at=? WHERE id=?').bind(now, caseId).run();
  await addCaseLog(caseId, 'unlink', '管理画面から LINE の紐づけを外した');
}

/* ── 表示用ヘルパ ── */

export function parseInterests(row: Pick<CaseRow, 'interests_json'>): string[] {
  try {
    const v = JSON.parse(row.interests_json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 記念日までの残り日数（JST）。日付が無ければ null、過ぎていれば負。 */
export function daysUntil(ymd: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const today = JST_YMD.format(new Date());
  const a = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  const b = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Math.round((a - b) / 86_400_000);
}
