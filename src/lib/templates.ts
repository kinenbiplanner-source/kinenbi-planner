/**
 * 管理画面の返信フォームで選べる定型文。
 *
 * 旧「応答テンプレ.html」の A〜I を、実際に管理画面から送る場面だけに絞って持ってきたもの。
 * 顧客対応の本線は LINE Official Account Manager のチャットで続ける前提なので、
 * ここにあるのは「案件を開いた流れでそのまま送れると楽なもの」だけ。
 *
 * 置き換え：{name}＝顧客名、{code}＝受付番号、{date}＝記念日（YYYY年M月D日）、{days}＝記念日までの日数。
 * 文面を変えるときはこのファイルを直す（DB には持たない。頻繁に変えるものではないため）。
 */

export interface ReplyTemplate {
  key: string;
  label: string;
  /** メールで送るときの件名。LINE では使わない */
  subject: string;
  body: string;
}

export const REPLY_TEMPLATES: readonly ReplyTemplate[] = [
  {
    key: 'first-contact',
    label: '初回連絡（受付後12時間以内）',
    subject: '【Anniv】お申し込みありがとうございます（受付番号 {code}）',
    body:
      '{name} 様\n\n' +
      'Anniv プランナーの担当です。お申し込みありがとうございます。\n' +
      'フォームの内容を拝見しました。{date} の記念日に向けて、一緒に準備を進めていきます。\n\n' +
      'まず、いくつか追加でお聞きしたいことがあります。\n' +
      '・当日はお二人で過ごされる予定でしょうか\n' +
      '・プレゼントは「形に残るもの」「体験」のどちらが近いイメージでしょうか\n\n' +
      '分かる範囲で構いませんので、このトークにそのまま返信してください。',
  },
  {
    key: 'hearing',
    label: '追加ヒアリング',
    subject: '【Anniv】いくつか確認させてください（受付番号 {code}）',
    body:
      '{name} 様\n\n' +
      'ご返信ありがとうございます。プランを具体的にするために、あと少しだけ教えてください。\n\n' +
      '1. 当日の予定（時間帯・エリア）\n' +
      '2. パートナーの方が「これは避けたい」と思いそうなもの\n' +
      '3. 予算の中で特に力を入れたい部分（プレゼント／食事／演出）\n\n' +
      '順不同で構いません。',
  },
  {
    key: 'proposal',
    label: 'プラン提案＋見積',
    subject: '【Anniv】プランのご提案（受付番号 {code}）',
    body:
      '{name} 様\n\n' +
      'お待たせしました。お聞きした内容から、次のプランをご提案します。\n\n' +
      '【プレゼント】\n（ここに内容）\n\n' +
      '【食事・場所】\n（ここに内容）\n\n' +
      '【当日の流れ】\n（ここに内容）\n\n' +
      '【お見積もり】\n合計 ○○,○○○円（内訳：…）\n\n' +
      'この内容で進めてよければ「OK」と返信してください。修正したい点があれば遠慮なくどうぞ。\n' +
      'ご納得いただくまで料金は発生しません。',
  },
  {
    key: 'invoice',
    label: '決済案内（Stripe Invoice）',
    subject: '【Anniv】お支払いのご案内（受付番号 {code}）',
    body:
      '{name} 様\n\n' +
      'プランのご承認ありがとうございます。お支払いは下記のリンクからお願いします。\n\n' +
      '（Stripe の Invoice URL をここに貼る）\n\n' +
      'クレジットカードでお支払いいただけます。お支払いが確認でき次第、手配に入ります。\n' +
      '領収書は決済完了後に自動でメール送信されます。',
  },
  {
    key: 'delivery',
    label: '納品（演出指示書の送付）',
    subject: '【Anniv】演出指示書をお送りします（受付番号 {code}）',
    body:
      '{name} 様\n\n' +
      '準備が整いました。当日の流れをまとめた演出指示書をお送りします。\n\n' +
      '（指示書のリンクまたは本文）\n\n' +
      'プレゼントの配送状況と、レストランの予約内容も指示書に記載しています。\n' +
      '当日までに不安な点があれば、いつでもこのトークで聞いてください。',
  },
  {
    key: 'follow',
    label: '記念日翌日のフォロー',
    subject: '【Anniv】昨日はいかがでしたか',
    body:
      '{name} 様\n\n' +
      '昨日の記念日、いかがでしたか。\n' +
      'パートナーの方の反応や、良かった点・こうすれば良かった点があれば、ぜひ聞かせてください。\n' +
      '次回に向けて、より良いご提案につなげていきます。\n\n' +
      'このたびは Anniv をご利用いただき、ありがとうございました。',
  },
  {
    key: 'consult-reply',
    label: '無料相談への返信',
    subject: '【Anniv】ご相談ありがとうございます',
    body:
      '{name} 様\n\n' +
      'ご相談ありがとうございます。Anniv プランナーの担当です。\n\n' +
      'いただいた内容について、（ここに回答）\n\n' +
      'もう少し具体的に進めたい場合は、下記の申込フォームからパートナーの方の好みなどを教えてください。\n' +
      'プランの提案までは無料で、料金はご納得いただいてからしか発生しません。\n' +
      'https://anniv.gift/apply',
  },
];

export function getTemplate(key: string): ReplyTemplate | undefined {
  return REPLY_TEMPLATES.find((t) => t.key === key);
}

export interface TemplateVars {
  name: string;
  code: string;
  /** YYYY-MM-DD。無ければ空 */
  anniversary_date: string;
}

function jpDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '記念日';
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

function daysUntil(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const b = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return String(Math.round((a - b) / 86_400_000));
}

/** {name} などを埋める。件名にも同じ置き換えを掛けてよい。 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\{name\}/g, vars.name || 'お客')
    .replace(/\{code\}/g, vars.code)
    .replace(/\{date\}/g, jpDate(vars.anniversary_date))
    .replace(/\{days\}/g, daysUntil(vars.anniversary_date));
}
