/**
 * 運営者への通知（受付・LINE 紐づけなど「人が動く必要がある出来事」を知らせる）。
 *
 * メール（OWNER_EMAIL 宛）と LINE push（LINE_OWNER_USER_ID 宛）の両方を試す。
 * 片方しか設定されていなければそちらだけ。両方とも best-effort で、失敗は console.warn に残すだけ
 * （通知が飛ばなくても案件は D1 に入っているので、管理画面を開けば分かる）。
 *
 * LINE_OWNER_USER_ID は運営者自身の LINE userId（U で始まる33文字）。
 * 自分で公式アカウントを友だち追加し、/admin の LINE 友だち一覧か line_users テーブルから拾って入れる。
 */
import { readVar, ownerEmail } from './config';
import { lineApiConfigured, pushText } from './line-api';
import { sendMail } from './mail';

export async function notifyOwner(subject: string, text: string): Promise<void> {
  const tasks: Array<Promise<boolean>> = [];

  tasks.push(
    sendMail({ to: ownerEmail(), subject, text }).then((r) => {
      if (!r.ok && !r.skipped) console.warn(`[notify] 運営者メールの送信に失敗: ${r.error ?? ''}`);
      return r.ok;
    }),
  );

  const ownerLine = readVar('LINE_OWNER_USER_ID');
  if (ownerLine && lineApiConfigured()) {
    tasks.push(
      pushText(ownerLine, `${subject}\n\n${text}`).then((r) => {
        if (!r.ok) console.warn(`[notify] 運営者 LINE の送信に失敗: ${r.error ?? ''}`);
        return r.ok;
      }),
    );
  }

  // sendMail / pushText は例外を投げない作りだが、念のため片方の失敗で他方を巻き込まない。
  const results = await Promise.allSettled(tasks);

  /*
    **1本も届かなかったときは必ずログに残す。**

    RESEND_API_KEY も LINE_OWNER_USER_ID も未設定だと、これまでは warn すら出ず完全に無音だった。
    案件自体は D1 に入るので管理画面を開けば分かるが、
    「申し込みが来たこと自体に気づけない」状態を黙って作るのが一番まずい。
    設定を入れ忘れたまま運用を始めたときに、`wrangler tail` でここが見える。
  */
  const delivered = results.some((r) => r.status === 'fulfilled' && r.value);
  if (!delivered) {
    console.warn(
      `[notify] 運営者へ1件も通知できなかった（RESEND_API_KEY / LINE_OWNER_USER_ID を確認）: ${subject}`,
    );
  }
}
