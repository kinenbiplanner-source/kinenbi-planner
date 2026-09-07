/**
 * LINE Messaging API の Webhook（POST /api/line/webhook）。
 *
 * LINE Developers の「Webhook URL」にこの URL を入れる。やることは3つ：
 *   - follow   … 友だち追加。line_users に行を作り（プロフィールも取りに行く）、
 *                **本人にアンケート（/survey）の案内を1通 push する**
 *   - unfollow … ブロック／解除。行は消さず unfollowed_at を立てる
 *   - message  … テキストだけ見る。**受付番号が入っていたら案件に紐づける**（受注フローの要）
 *
 * 申し込みを2段階に分けたので（2026-09-07）、**友だち追加が2段目の起点**になる。
 * `/apply` で聞くのは3つだけで、記念日・予算・パートナーの好みは follow の push から
 * `/survey` に来てもらって受け取る。詳しくは src/lib/intake.ts の冒頭。
 *
 * 受付番号は、サンクスページの1タップ導線と無料相談の受付確認メールから送られてくる
 * （`受付番号 K7M2-4QXA` のようなメッセージ）。それを src/lib/cases.ts の extractCode で拾い、
 * cases.line_user_id に結びつける。以降の顧客対応は LINE Official Account Manager の
 * チャットで人が行い、ここは「誰がどの案件か」を作るところまでを担う。
 *
 * ## 認証と 200 の扱い
 *
 * **認証を掛けられない公開 API**（LINE のサーバから素で飛んでくる）ので
 * src/middleware.ts の PUBLIC_API に入れてある。防御線は `X-Line-Signature` の HMAC 検証だけで、
 * ここを外すと誰でも偽の follow / message を投げて他人の LINE を案件に紐づけられる。
 *
 * 署名 NG は 401。それ以外は**何が起きても最後は 200 を返す**。LINE は 200 以外を受け取ると
 * 同じイベントを再送するので、こちら側のバグで 500 を返し続けると再送も延々続く
 * （そのたびに reply や push が走ると通数まで溶ける）。イベント単位で try/catch して握り、
 * 失敗は console.error にだけ残す。
 */
import type { APIRoute } from 'astro';
import {
  addCaseLog,
  extractCode,
  findCaseByLineUser,
  findLinkCandidates,
  getCaseByCode,
  linkLineUser,
} from '../../../lib/cases';
import { readVar, siteUrl } from '../../../lib/config';
import { getLineUser, markLineUnfollow, recordLineMessage, touchLineUser, upsertLineUser } from '../../../lib/line';
import { getLineProfile, lineApiConfigured, pushText, replyText, verifyLineSignature } from '../../../lib/line-api';
import { notifyOwner } from '../../../lib/notify';

export const prerender = false;

/**
 * 1リクエストで処理するイベント数の上限。
 * Workers の無料プランはリクエストあたりのサブリクエストが50までで、1イベントで
 * D1 のクエリと LINE API 呼び出しを数本使う。まとめて大量に届いたときに
 * 上限に当たって全部落ちるより、先頭から確実に捌く方がまし（実運用で20件も同時には来ない）。
 */
const MAX_EVENTS = 20;

/* ── Webhook のイベント（必要な項目だけの最小定義） ── */

interface LineEventSource {
  type?: string;
  /** グループやルームからのイベントには入らないことがある。 */
  userId?: string;
}

interface LineEventMessage {
  type?: string;
  text?: string;
}

interface LineWebhookEvent {
  type?: string;
  /** ミリ秒の epoch。 */
  timestamp?: number;
  replyToken?: string;
  source?: LineEventSource;
  message?: LineEventMessage;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 生の JSON から、こちらが使う項目だけを型の付いた形に写す。 */
function toEvent(v: unknown): LineWebhookEvent | null {
  if (!isRecord(v)) return null;
  const src = isRecord(v.source) ? v.source : undefined;
  const msg = isRecord(v.message) ? v.message : undefined;
  return {
    type: str(v.type),
    timestamp: typeof v.timestamp === 'number' && Number.isFinite(v.timestamp) ? v.timestamp : undefined,
    replyToken: str(v.replyToken),
    source: src ? { type: str(src.type), userId: str(src.userId) } : undefined,
    message: msg ? { type: str(msg.type), text: str(msg.text) } : undefined,
  };
}

/** イベントの発生時刻。届かない・壊れているときは受信時刻で代用する。 */
function eventTime(ev: LineWebhookEvent): string {
  if (ev.timestamp !== undefined) {
    const d = new Date(ev.timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/* ── イベントの処理 ── */

async function handleFollow(userId: string, at: string): Promise<void> {
  const profile = await getLineProfile(userId);
  const displayName = profile?.displayName ?? '';
  await upsertLineUser({ user_id: userId, display_name: displayName, picture_url: profile?.pictureUrl ?? '' }, at);

  // 既に案件と紐づいている相手の再追加（ブロック解除）は、対応の文脈が変わるので履歴に残す。
  const c = await findCaseByLineUser(userId);
  if (c) {
    await addCaseLog(c.id, 'line_in', '友だち追加（再追加）');
    return;
  }

  /*
    未紐づけの友だち追加。**顧客に受付番号を送らせないための本線がここ。**

    申し込みからサンクスページの緑のボタンを押して追加するまでは数十秒なので、
    直前に来た未紐づけの申し込みがほぼ本人になる。それを通知に載せて、
    運営者が /admin/cases でワンタップ確定できるようにする。

    **ここで自動確定はしない。** Instagram のプロフィールから申し込みと無関係に
    追加する人がいて、窓の中にたまたま未紐づけの案件が1件あると他人に結びつく。
    取り違えると別人の記念日プランと個人情報を送ることになるので、最後は人が見る。
  */
  const candidates = await findLinkCandidates(at);
  const who = displayName || '（表示名なし）';
  const lines = [
    `LINE の友だち追加がありました：${who}`,
    '',
  ];
  if (candidates.length === 0) {
    lines.push('近い時間の申し込みは見つかりませんでした。申込者以外の追加かもしれません。');
  } else {
    lines.push('直前に申し込んだ人（この人の可能性が高い順）：');
    for (const cand of candidates) {
      // 追加より後に申し込んだケース（既に友だちの人）も候補に出るので、前後の両方を言葉にする
      const m = cand.minutesAfter;
      const abs = Math.abs(m);
      const span = abs < 60 ? `${abs}分` : abs < 1440 ? `${Math.round(abs / 60)}時間` : `${Math.round(abs / 1440)}日`;
      const when = abs < 1 ? 'ほぼ同時' : m > 0 ? `${span}前に申込` : `${span}後に申込`;
      lines.push(`  ${cand.case.code} ${cand.case.name}（${when}／LINE名の申告: ${cand.case.line_name || '—'}）`);
    }
    lines.push('');
    lines.push('表示名と見比べて、合っていれば管理画面で「紐づける」を押してください。');
  }
  lines.push('', `${siteUrl()}/admin/cases`);
  await notifyOwner(`【Anniv】LINE 友だち追加 ${who}`, lines.join('\n'));

  /*
    友だち追加した本人へアンケートの案内を送る。**2段階に分けた申し込みの2段目の入口がここ。**
    `/apply` では3つしか聞いていないので、記念日・予算・パートナーの好みはこの案内から拾う。

    **候補が1件に絞れていても、受付番号入りのリンクは送らない。** 候補はあくまで時刻の近さで
    並べたもので、無関係な追加が混ざれば他人の受付番号を渡すことになる。番号入りのリンクを送るのは
    linkLineUser が済んだあと（人が管理画面で確定したとき、または受付番号を送ってもらったとき）に限る。
    その代わり、汎用の案内では**申し込み時のメールで突き合わせられる**ことを本文に書いておく
    （/api/survey は受付番号が無ければメールで案件を引く）。
  */
  if (!lineApiConfigured()) {
    // 黙って飛ばすと、運営者は「友だち追加がありました」通知だけを見て
    // 案内済みだと誤解したまま待ってしまう。設定漏れに気づけるようにする。
    console.warn('[line-webhook] LINE_CHANNEL_ACCESS_TOKEN が未設定のためアンケート案内を送っていない');
    return;
  }
  const invite = [
    '友だち追加ありがとうございます。Anniv の担当です。',
    '',
    'より良いご提案のために、あと1〜2分だけアンケートにご協力ください（分かる範囲で大丈夫です）。',
    `${siteUrl()}/survey`,
    '',
    'お申し込み時のメールアドレスを入力いただくと、あなたのお申し込みと結びつきます。',
    '',
    'お答えいただいたあと、担当からご連絡します。',
  ].join('\n');
  const sent = await pushText(userId, invite);
  if (!sent.ok) {
    console.error(`[line-webhook] アンケート案内の送信に失敗 user=${userId}: ${sent.error ?? ''}`);
    return;
  }
  // 送った控えを残す（管理画面のトーク履歴で「案内済みかどうか」が分かるように）。
  await recordLineMessage(userId, 'out', invite, at);
}

async function handleUnfollow(userId: string, at: string): Promise<void> {
  await markLineUnfollow(userId, at);
  const c = await findCaseByLineUser(userId);
  if (c) await addCaseLog(c.id, 'line_in', 'ブロック／友だち解除');
}

async function handleTextMessage(ev: LineWebhookEvent, userId: string, at: string): Promise<void> {
  const text = ev.message?.text ?? '';
  const replyToken = ev.replyToken ?? '';

  // 表示名は管理画面で「誰から来たか」を見るのに要る。行が無い／名前が空のときだけ取りに行く
  // （プロフィール取得は LINE API へのサブリクエストなので、毎回は叩かない）。
  const existing = await getLineUser(userId);
  let displayName = existing?.display_name ?? '';
  let pictureUrl = existing?.picture_url ?? '';
  if (!existing || !displayName) {
    const profile = await getLineProfile(userId);
    if (profile) {
      displayName = profile.displayName || displayName;
      pictureUrl = profile.pictureUrl || pictureUrl;
    }
  }
  await touchLineUser({ user_id: userId, display_name: displayName, picture_url: pictureUrl }, at);
  await recordLineMessage(userId, 'in', text, at, ev);

  const code = extractCode(text);
  if (code) {
    const c = await getCaseByCode(code);
    if (c) {
      /*
        **既に別の LINE アカウントが紐づいている案件は、自動では奪わせない。**

        受付番号はワンタイムでも期限付きでもなく、サンクスページのURL・受付確認メール・
        スクリーンショットのどこからでも漏れうる。そのまま上書きを許すと、番号を知った
        第三者が OA にひとこと送るだけで、以後のプラン提案・見積・配送先のやり取りが
        まるごとその人に流れる。運営者の画面には「紐づいた」としか出ないので気づけない。

        付け替えが正当なケース（機種変更・アカウント作り直し）もあるので拒否はせず、
        運営者に知らせて /admin/cases の手動紐づけに委ねる。
      */
      if (c.line_user_id && c.line_user_id !== userId) {
        await addCaseLog(
          c.id,
          'line_in',
          `別のLINEアカウントから受付番号が届いた（表示名: ${displayName || '不明'}）。自動では紐づけていない`,
        );
        await replyText(
          replyToken,
          'ご連絡ありがとうございます。担当が確認のうえ、あらためてご連絡します。',
        );
        await notifyOwner(
          `【Anniv】要確認：受付番号の重複 ${c.name}`,
          [
            '既に別の LINE アカウントが紐づいている案件へ、受付番号が送られてきました。',
            '**自動では紐づけていません。** 本人か確認してから手動で紐づけてください。',
            '',
            `受付番号：${c.code}`,
            `お名前：${c.name}`,
            `送ってきた人の表示名：${displayName || '（取得できず）'}`,
            '',
            `管理画面：${siteUrl()}/admin/cases/${c.id}`,
          ].join('\n'),
        );
        return;
      }

      await linkLineUser(c.id, userId, `LINE で受付番号を受信（表示名: ${displayName || '不明'}）`);
      /*
        紐づけが確定したので、**ここでだけ受付番号入りのアンケートリンクを出す。**
        follow のときは案件が確定しておらず、番号を載せると他人の番号を渡す恐れがあった。
        番号がURLに入っていればメールを打たずに答えられる（/api/survey が code で案件を引く）。
        既に答えている人（survey_at あり）には出さない。同じ案内を二度出すと不信感になる。
      */
      const reply = c.survey_at
        ? `受付番号 ${c.code} を確認しました。担当から順にご連絡しますので、少しお待ちください。`
        : [
            `受付番号 ${c.code} を確認しました。`,
            '',
            'まだアンケートにお答えいただいていないようです。よろしければこちらから：',
            `${siteUrl()}/survey?c=${c.code}`,
            '',
            '担当から順にご連絡しますので、少しお待ちください。',
          ].join('\n');
      // reply は通数を消費しないので自動応答はこちらを使う。replyToken は1イベント1回だけ。
      await replyText(replyToken, reply);
      await notifyOwner(
        `【Anniv】LINE 紐づけ ${c.name}`,
        [
          'LINE から受付番号が届いて案件に紐づきました。',
          '',
          `受付番号：${c.code}`,
          `お名前：${c.name}`,
          `LINE 表示名：${displayName || '（取得できず）'}`,
          '',
          `管理画面：${siteUrl()}/admin/cases/${c.id}`,
        ].join('\n'),
      );
      return;
    }
    // 番号の形はしているが該当が無い＝打ち間違いか、別サービスの番号。
    await replyText(
      replyToken,
      '受付番号が見つかりませんでした。受付確認メールに記載の番号をもう一度お送りください。',
    );
    return;
  }

  // 番号なしの普通のメッセージ。**自動返信はしない**（対応は人が LINE のチャットで返すため、
  // ここで bot が割り込むと会話が二重になる）。紐づいている案件があれば履歴にだけ残す。
  const linked = await findCaseByLineUser(userId);
  if (linked) await addCaseLog(linked.id, 'line_in', text);
}

async function handleEvent(ev: LineWebhookEvent): Promise<void> {
  const userId = ev.source?.userId ?? '';
  // userId が無い（グループ・ルーム由来など）と誰の話か決まらないので何もしない。
  if (!userId) return;
  const at = eventTime(ev);

  if (ev.type === 'follow') return await handleFollow(userId, at);
  if (ev.type === 'unfollow') return await handleUnfollow(userId, at);
  if (ev.type === 'message' && ev.message?.type === 'text') return await handleTextMessage(ev, userId, at);
  // join / leave / postback / 画像・スタンプなどは受注フローに関係しないので無視する。
}

/* ── 受け口 ── */

function ok(): Response {
  return new Response('ok', { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  // 署名は**生ボディ**に対して計算されている。JSON.parse して stringify し直すと一致しない。
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (e) {
    console.error('[line-webhook] ボディを読めなかった', e);
    return ok();
  }

  const verified = await verifyLineSignature(rawBody, request.headers.get('X-Line-Signature'));
  if (!verified) {
    // 例外は「ローカル開発でチャネルシークレットを持っていないとき」だけ。
    // 本番（DEV でない）や、シークレットが入っているのに署名が合わない場合は必ず弾く。
    const devBypass = import.meta.env.DEV && readVar('LINE_CHANNEL_SECRET') === '';
    if (!devBypass) {
      console.error('[line-webhook] 署名の検証に失敗');
      return new Response('signature verification failed', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    console.warn('[line-webhook] LINE_CHANNEL_SECRET が未設定のため署名検証をスキップ（開発時のみ）');
  }

  let events: LineWebhookEvent[] = [];
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const list = isRecord(parsed) ? parsed.events : null;
    if (Array.isArray(list)) {
      events = list.map(toEvent).filter((e): e is LineWebhookEvent => e !== null);
    }
  } catch (e) {
    console.error('[line-webhook] JSON を読めなかった', e);
    return ok();
  }

  if (events.length > MAX_EVENTS) {
    console.warn(`[line-webhook] イベントが ${events.length} 件届いたので先頭 ${MAX_EVENTS} 件だけ処理する`);
  }

  // 順に処理する（同じ相手の follow → message が入れ替わらないように並列にしない）。
  for (const ev of events.slice(0, MAX_EVENTS)) {
    try {
      await handleEvent(ev);
    } catch (e) {
      console.error(`[line-webhook] イベント処理で例外 type=${ev.type ?? '?'}`, e);
    }
  }

  return ok();
};
