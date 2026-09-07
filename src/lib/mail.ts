/**
 * メール送信（Resend）と、受注フローで送る定型文。
 *
 * 旧フローの Make → Gmail の置き換え。送信は Resend の REST API 1本で、SDK は入れない
 * （fetch で足りるし Workers でそのまま動く）。
 *
 * すべての関数は例外を投げない。メールが送れなくても案件の保存は済んでいるので、
 * 失敗は戻り値で返し、呼び出し側が case_log に「送れていない」を残す（src/pages/api/apply.ts）。
 *
 * 設定は wrangler secret（src/lib/config.ts の readVar で読む）：
 *   RESEND_API_KEY … 無ければ { ok:false, skipped:true } を返して何もしない
 *   MAIL_FROM      … 送信元。既定は Anniv <noreply@anniv.gift>（Resend でドメイン認証済みであること）
 *
 * 文面はここに持つ（DB には置かない。管理画面の定型文 src/lib/templates.ts と同じ考え方）。
 */
import { readVar, lineAddUrl, ownerEmail, siteUrl } from './config';
import { parseInterests, type CaseRow } from './cases';
import { DELEGATION_OPTIONS, EXPRESS_OPTIONS, kindLabel } from './intake';
import { oaMessageUrl } from './line';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface SendMailResult {
  ok: boolean;
  /** Resend が返すメッセージID */
  id?: string;
  error?: string;
  /** RESEND_API_KEY が未設定で送っていない */
  skipped?: boolean;
}

export function mailConfigured(): boolean {
  return readVar('RESEND_API_KEY') !== '';
}

function mailFrom(): string {
  return readVar('MAIL_FROM') || 'Anniv <noreply@anniv.gift>';
}

export async function sendMail(opts: SendMailOptions): Promise<SendMailResult> {
  const apiKey = readVar('RESEND_API_KEY');
  if (!apiKey) return { ok: false, skipped: true, error: 'RESEND_API_KEY が未設定' };

  const to = opts.to.trim();
  if (!to) return { ok: false, error: '宛先が空' };
  const subject = opts.subject.trim();
  if (!subject) return { ok: false, error: '件名が空' };

  const payload: Record<string, unknown> = {
    from: mailFrom(),
    to: [to],
    subject,
    text: opts.text,
  };
  if (opts.html) payload.html = opts.html;
  if (opts.replyTo) payload.reply_to = opts.replyTo;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${bodyText.slice(0, 300)}` };
    let id: string | undefined;
    try {
      const data = JSON.parse(bodyText) as { id?: unknown };
      if (typeof data.id === 'string') id = data.id;
    } catch {
      // id が読めなくても送信は成功している
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ── 定型文 ── */

export interface MailContent {
  subject: string;
  text: string;
}

/** YYYY-MM-DD → 2026年12月24日。空や不正なら「未定」。 */
function jpDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '未定';
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

const JST_DATETIME = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function jstDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : JST_DATETIME.format(d);
}

function expressLabel(v: number): string {
  return EXPRESS_OPTIONS.find((o) => o.value === String(v))?.label ?? (v ? 'スピード対応' : '通常');
}

function delegationLabel(v: string): string {
  return DELEGATION_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/**
 * 申込（kind=apply）の受付確認メールの冒頭に置く LINE 案内。
 *
 * **申し込みを2段階に分けたので、ここで頼むのは「友だち追加」だけ**（2026-09-07）。
 * 受付番号の送信は求めない——追加を Webhook が検知したら、こちらからアンケートの案内を
 * 自動で送る（src/pages/api/line/webhook.ts の handleFollow）。番号の入力を挟むほど脱落する。
 */
function lineAddGuide(): string {
  return [
    '■ まず LINE の友だち追加をお願いします',
    `友だち追加：${lineAddUrl()}`,
    '',
    '担当からのご連絡はすべて LINE で行います。追加していただかないとご連絡ができません。',
    '友だち追加のあと、記念日・ご予算・パートナーの方の好みをうかがうアンケートを LINE でお送りします。',
  ].join('\n');
}

/**
 * 無料相談（kind=consult）の受付確認メールの冒頭に置く LINE 案内。
 *
 * **顧客に受付番号を送らせない。** 申込の直後に友だち追加した人は、管理画面側で
 * 申込時刻から突き合わせて紐づける（src/lib/cases.ts の rankLinkCandidates）。
 * `public/contact.html` の完了画面も「追加するだけで大丈夫です」と書いているので、
 * メールだけ「番号を送れ」と言うと案内が食い違う。番号は控えとして末尾に出す。
 *
 * oaMessage の URL は @ベーシックID がある時だけ出す（1タップで番号まで送れて確実に紐づくため。
 * 無ければ lin.ee の友だち追加だけ）。
 */
function lineGuide(code: string): string {
  const lines = [
    '■ まず LINE の友だち追加をお願いします',
    '担当からのご連絡は LINE で行います。追加していただくだけで大丈夫です。',
    '',
    `友だち追加：${lineAddUrl()}`,
  ];
  const oa = oaMessageUrl(code);
  if (oa) lines.push(`受付番号を送る（タップすると受付番号を自動入力）：${oa}`);
  return lines.join('\n');
}

function footer(): string {
  return [
    'このメールは送信専用のアドレスから送っています。',
    `ご質問は LINE のトーク、または ${ownerEmail()} までお願いします。`,
    '',
    'Anniv',
    siteUrl(),
  ].join('\n');
}

/**
 * 申込フォーム（kind=apply）の受付確認。顧客宛。
 *
 * **主役は LINE の友だち追加**（2026-09-07 の2段階化）。入口では3つしか聞いていないので、
 * このメールで伝えることは「友だち追加さえすれば話が進む」の一点に絞る。
 * 記念日や予算は友だち追加のあと LINE から案内するアンケートで受け取るため、ここでは触れない。
 * 受付番号は送信を求めず、問い合わせ用の控えとして末尾に置く。
 */
export function receiptMailForApply(c: CaseRow): MailContent {
  const subject = `【Anniv】お申し込みありがとうございます（受付番号 ${c.code}）`;
  const text = [
    `${c.name} 様`,
    '',
    'Anniv へのお申し込みありがとうございます。',
    '',
    lineAddGuide(),
    '',
    '■ この後の流れ',
    '1. LINE を友だち追加していただく',
    '2. LINE で届くアンケートにお答えいただく（1〜2分。分かる範囲で大丈夫です）',
    '3. 当日中〜翌営業日に、担当から LINE でご連絡します',
    '',
    'ヒアリングのうえプランと見積をお出しします。プランが確定するまで料金は発生しません。',
    '',
    '■ 先に希望を伝えておきたい場合はこちら',
    `${siteUrl()}/survey?c=${c.code}`,
    '',
    '■ 受付内容',
    `お名前：${c.name}`,
    `メール：${c.email}`,
    `受付番号：${c.code}（お問い合わせのときにお使いください）`,
    '',
    footer(),
  ].join('\n');
  return { subject, text };
}

/** 無料相談（kind=consult）の受付確認。顧客宛。 */
export function receiptMailForConsult(c: CaseRow): MailContent {
  const subject = `【Anniv】ご相談ありがとうございます（受付番号 ${c.code}）`;
  const text = [
    `${c.name} 様`,
    '',
    'Anniv への無料相談のお申し込みありがとうございます。',
    `受付番号は ${c.code} です。`,
    '',
    lineGuide(c.code),
    '',
    '■ 受付内容',
    `お名前：${c.name}`,
    `記念日：${c.anniversary || '未記入'}`,
    `日付：${jpDate(c.anniversary_date)}`,
    '種別：無料相談',
    '',
    '■ ご相談内容',
    c.message || '（未記入）',
    '',
    '■ この後の流れ',
    '当日中〜翌営業日に、担当から LINE でお返事します。',
    '相談は無料です。プランをご依頼いただく場合も、内容が確定するまで料金は発生しません。',
    '',
    // 相談から具体的な依頼へ進む人のための近道。申込フォームを通らずここから
    // 記念日・予算・パートナーの好みを埋めてもらえると、初回の提案が一段早くなる。
    '■ 先にご希望を伝えておきたい場合',
    `記念日やご予算、パートナーの方の好みをお聞かせいただけると、ご提案が早くなります。`,
    `${siteUrl()}/survey?c=${c.code}`,
    '',
    footer(),
  ].join('\n');
  return { subject, text };
}

/**
 * 運営者宛の受付通知。全項目を平文で並べ、末尾に管理画面の URL を置く。
 * 旧 Make → Gmail の通知メールの置き換えなので、メールだけで中身が分かる粒度にしている。
 */
export function ownerNoticeMail(c: CaseRow): MailContent {
  const kind = kindLabel(c.kind);
  const subject = `【Anniv 受付】${kind} ${c.name}（${c.code}）`;

  const rows: Array<[string, string]> = [
    ['受付番号', c.code],
    ['種別', kind],
    ['受付日時', jstDateTime(c.created_at)],
    ['お名前', c.name],
    ['メール', c.email],
  ];
  if (c.kind === 'apply') {
    rows.push(['LINE 名（申告）', c.line_name]);
    /*
      申し込みを2段階に分けたので、**受付の直後はアンケートの列がまだ全部空**。
      「—」を十数行並べても読めないだけなので、未回答のときは1行で状態だけ出す
      （この通知は /api/apply から受付直後に送るため、実際はほぼ「未回答」になる）。
    */
    if (c.survey_at) {
      rows.push(
        ['アンケート', `回答済み（${jstDateTime(c.survey_at)}）`],
        ['電話', c.phone],
        ['年齢', c.age],
        ['パートナーの年齢', c.partner_age],
        ['交際期間', c.relationship],
        ['記念日', c.anniversary],
        ['日付', c.anniversary_date ? `${c.anniversary_date}（${jpDate(c.anniversary_date)}）` : ''],
        ['予算', c.budget],
        ['申込種別', expressLabel(c.express)],
        ['お任せ度合い', delegationLabel(c.delegation)],
        ['パートナーの興味', parseInterests(c).join('、')],
        ['これまでの過ごし方', c.past_style],
        ['希望・こだわり', c.wishes],
      );
    } else {
      rows.push(['アンケート', '未回答（友だち追加のあと LINE で案内する）']);
    }
  } else {
    rows.push(
      ['記念日', c.anniversary],
      ['日付', c.anniversary_date ? `${c.anniversary_date}（${jpDate(c.anniversary_date)}）` : ''],
      ['相談内容', c.message],
    );
  }
  rows.push(['流入元', [c.source, c.medium, c.campaign].filter(Boolean).join(' / ')]);

  const text = [
    `${kind}が届きました。`,
    '',
    ...rows.map(([k, v]) => `${k}：${v || '—'}`),
    '',
    `管理画面：${siteUrl()}/admin/cases/${c.id}`,
  ].join('\n');
  return { subject, text };
}
