/**
 * 詳しいアンケート（/survey）の受け口（POST /api/survey）。
 *
 * 申し込みを2段階に分けたときの2段目（2026-09-07）。入口の `/apply` は
 * 「お名前・メール・LINE名」の3つだけで案件を作り、記念日・予算・パートナーの好みは
 * 友だち追加のあと LINE から案内するこの画面で聞く。
 *
 * **ここは新しい案件を作らない。** `/apply` で作った行を `applySurvey` で更新するだけで、
 * `cases.survey_at` が入っているものが「回答済み」になる（schema.sql 末尾）。
 *
 * ## どの案件かをどう決めるか
 *
 * どちらか一方が取れれば十分：
 *   - `code` … `/survey?c=XXXX-XXXX` で来た人（受付確認メールと LINE の確認返信のリンク）
 *   - `email` … LINE のあいさつメッセージから素の `/survey` を開いた人。番号を持っていないので、
 *               申し込み時に入れたメールで本人を特定する
 * どちらでも見つからなければ 404 を返す。**「この申し込みは存在する／しない」が外から分かる**が、
 * 受付番号は推測が難しく、メールは本人しか知らないので許容する。ここを曖昧に 200 で返すと
 * 「送ったのに反映されない」が起き、原因を画面で説明できなくなるほうが損。
 *
 * ## 認証と防御
 *
 * **認証を掛けられない公開 API** なので src/middleware.ts の PUBLIC_API に入れてある。
 * `/api/apply` と違って **Turnstile は掛けない**。LINE のトークから開く画面なので
 * ウィジェットの表示が挟まると離脱するし、既に案件がある人しか通れない（＝作れる行が無く、
 * できるのは自分の案件の上書きだけ）ぶん、入口より攻撃の旨味が小さい。
 * 代わりにハニーポット（intake.ts の website 欄）と同一IPのレート制限で受ける。
 * 制限は `/api/apply` より緩い10回：**言い直しで送り直す人がいる**ため。
 *
 * ## 保存と通知の関係
 *
 * `/api/apply` と同じで、**通知が飛ばなくても保存が済んでいれば成功で返す。**
 * 回答は D1 に入っていて管理画面から見えるので、ここで 500 を返して送り直させる方が損。
 */
import type { APIRoute } from 'astro';
import {
  applySurvey,
  createCase,
  findCaseByEmail,
  findCaseByLineUser,
  getCase,
  getCaseByCode,
  linkLineUser,
  parseInterests,
  addCaseLog,
  type CaseRow,
} from '../../lib/cases';
import { siteUrl } from '../../lib/config';
import { DELEGATION_OPTIONS, formDataToRecord, parseSurvey } from '../../lib/intake';
import { findLineUserByToken, type LineUserRow } from '../../lib/line';
import { notifyOwner } from '../../lib/notify';

export const prerender = false;

/**
 * ボディ上限。自由記入は「希望・こだわり」1000字と興味の配列くらいなので、
 * 正常な送信は数KBに収まる。64KB は余裕を持たせた上限で、これを超えるのは事故か攻撃。
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 同一IPからの送信回数の上限（RATE_WINDOW_MS の間に RATE_MAX 回まで）。
 * `/api/apply` の5回より緩いのは、アンケートは**書き直して送り直す**ことがあるため。
 */
const RATE_MAX = 10;
const RATE_WINDOW_MS = 10 * 60_000;

/**
 * IPごとの送信時刻。Worker のインスタンスに載るだけなので厳密ではない
 * （/api/apply・/api/ev と同じ割り切り。本気の攻撃は Cloudflare の
 *  Rate Limiting Rules で前段に落とす前提の下限の防御）。
 */
const hits = new Map<string, number[]>();
const RATE_MAX_ENTRIES = 2000;

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);

  // Map が無限に伸びないよう、溜まってきたら窓を過ぎたIPを掃除する。
  if (hits.size >= RATE_MAX_ENTRIES) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
    }
    if (hits.size >= RATE_MAX_ENTRIES) hits.clear();
  }
  hits.set(ip, recent);
  return false;
}

/** /api/apply と同じ取り方。Cloudflare 経由なら CF-Connecting-IP が付く。 */
function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0]!.trim();
  return 'local';
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

/** 素の <form> ポスト用。303 にするのは、リロードで同じ POST が飛ばないようにするため。 */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/**
 * JS 無しで送ってきた人向けのエラー画面（/api/apply と同じ作り）。
 * 入力値はここには戻せないので「戻るボタンで戻って直す」と明示する。
 * ステータスを引数にするのは、案件が見つからないとき 404 で返したいため。
 */
function errorHtml(errors: string[], heading: string, status = 400): Response {
  const items = errors.length ? errors : ['入力内容を確認してください'];
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${esc(heading)}</title>` +
      `<style>body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#fafaf8;color:#2d3748;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
      `div{max-width:520px;background:#fff;border:1px solid #d1e8f5;border-radius:8px;padding:32px;` +
      `box-shadow:0 2px 12px rgba(26,40,64,.06)}h1{font-size:18px;color:#1a2840;margin:0 0 12px}` +
      `ul{font-size:14px;line-height:1.9;margin:0 0 16px;padding-left:20px}p{font-size:14px;line-height:1.9;margin:0}` +
      `</style></head><body><div><h1>${esc(heading)}</h1>` +
      `<ul>${items.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` +
      `<p>ブラウザの戻るボタンで戻って修正してください。</p></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } },
  );
}

/** 受付番号の形（cases.ts の generateCode と対）。 */
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function delegationLabel(v: string): string {
  return DELEGATION_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/**
 * 運営者への通知。**アンケートが埋まった時点が「提案を作り始められる」合図**なので、
 * 申し込みの受付通知（/api/apply）とは別に1通出す。
 * best-effort で、失敗しても応答は成功のまま返す。
 */
async function notifySurvey(c: CaseRow, notes: string[] = []): Promise<void> {
  const rows: Array<[string, string]> = [
    ['受付番号', c.code],
    ['お名前', c.name],
    ['記念日', c.anniversary],
    ['日付', c.anniversary_date],
    ['予算', c.budget],
    ['お任せ度合い', delegationLabel(c.delegation)],
    ['パートナーの興味', parseInterests(c).join('、')],
    ['希望・こだわり', c.wishes],
  ];
  await notifyOwner(
    `【Anniv】アンケート回答 ${c.name}`,
    [
      'アンケートの回答が届きました。',
      // 新規作成・紐づけの衝突など、**あなたが手を動かす必要がある事情**は本文の頭に出す。
      ...(notes.length ? ['', ...notes.map((n) => `※ ${n}`)] : []),
      '',
      ...rows.map(([k, v]) => `${k}：${v || '—'}`),
      '',
      `管理画面：${siteUrl()}/admin/cases/${c.id}`,
    ].join('\n'),
  );
}

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);

  // 先にヘッダだけで落とせるものを落とす（巨大なボディを読み込まないため）。
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    console.error(`[survey] ボディが大きすぎる ip=${ip} length=${declared}`);
    return json({ ok: false, error: 'too_large' }, 413);
  }

  if (rateLimited(ip, Date.now())) {
    console.error(`[survey] レート制限 ip=${ip}`);
    return json({ ok: false, error: 'rate_limit' }, 429);
  }

  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const accept = (request.headers.get('Accept') ?? '').toLowerCase();
  const isJsonRequest = contentType.includes('application/json');
  /** 応答を JSON で返すか。JSON で送ってきたか、JSON を受け取りたいと言っているか。 */
  const wantsJson = isJsonRequest || accept.includes('application/json');

  let raw: Record<string, unknown>;
  try {
    if (isJsonRequest) {
      const body = await request.text();
      // Content-Length が付かない送り方（chunked）への保険。文字数はバイト数より小さめに出るが、
      // ここは事故と攻撃を弾ければよいので厳密なバイト数は要らない。
      if (body.length > MAX_BODY_BYTES) {
        console.error(`[survey] JSON ボディが大きすぎる ip=${ip}`);
        return json({ ok: false, error: 'too_large' }, 413);
      }
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object ではない');
      raw = parsed as Record<string, unknown>;
    } else {
      raw = formDataToRecord(await request.formData());
    }
  } catch (e) {
    console.error(`[survey] ボディを読めなかった ip=${ip}`, e);
    return wantsJson
      ? json({ ok: false, error: 'bad_request' }, 400)
      : errorHtml(['送信内容を読み取れませんでした'], '入力に不備があります');
  }

  /*
    どの案件かを先に決める。**検証より先にやる**のは、回答が正しくても宛先が無ければ
    保存しようがなく、画面に出したいエラーも「見つからない」だからで、
    設問のエラーと混ぜて返すと利用者がどちらを直せばいいか分からなくなるため。
  */
  const codeRaw = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : '';
  const code = CODE_RE.test(codeRaw) ? codeRaw : '';
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const token = typeof raw.t === 'string' ? raw.t.trim() : '';

  /*
    照会の順番は 受付番号 → メール → LINE のトークン。

    受付番号が一番強い（推測できない8桁で、本人にしか届いていない）。
    メールは「申し込んだ本人がその画面を開いた」ことの弱い証拠だが、
    従来からの導線なので残す。トークンは**こちらが特定のトークへ push したURL**なので
    LINE ユーザーの特定としては確実。ただし「どの申し込みか」は分からないので、
    紐づけ済みの案件がある場合の受け皿として最後に使う。
  */
  let lineUser: LineUserRow | null = null;
  let c: CaseRow | null = null;
  try {
    if (token) lineUser = await findLineUserByToken(token);
    if (code) c = await getCaseByCode(code);
    else if (email) c = await findCaseByEmail(email);
    if (!c && lineUser) c = await findCaseByLineUser(lineUser.user_id);
  } catch (e) {
    console.error(`[survey] 案件の照会に失敗 ip=${ip}`, e);
    return wantsJson
      ? json({ ok: false, error: 'server' }, 500)
      : errorHtml(['お申し込みを照会できませんでした。時間をおいて再度お試しください'], '保存できませんでした', 500);
  }

  /*
    案件は無いが LINE のトークンは正しい＝**申し込みを通っていない人**。
    Instagram のプロフィールから友だち追加した人、あるいは申し込みと違うメールアドレスを
    入れた人がここに来る。404 で突き返すと、1〜2分かけて書いた回答が丸ごと消えて
    こちらにも何も残らない。**新しい案件として受け止める**（重複したら管理画面で統合する）。

    メールが空のときは作らない。連絡手段が無い案件を作っても追いかけようがない
    （画面側では必須なので、ここに来るのは JS 無しで手で送った場合くらい）。
  */
  let createdFromLine = false;
  if (!c && lineUser && email) {
    try {
      c = await createCase(
        {
          kind: 'apply',
          name: lineUser.display_name || 'LINE のお客様',
          email,
          line_name: lineUser.display_name,
        },
        { submission: {}, source: 'line', medium: 'survey', campaign: '' },
      );
      createdFromLine = true;
      await addCaseLog(
        c.id,
        'note',
        'LINE のアンケートから受付（お申し込みが見つからなかったため新規に作成）',
      );
    } catch (e) {
      console.error(`[survey] LINE のトークンから案件を作れなかった user=${lineUser.user_id}`, e);
    }
  }

  if (!c) {
    console.warn(`[survey] 該当する案件が無い ip=${ip} code=${code || '—'} email=${email ? 'あり' : 'なし'}`);
    return wantsJson
      ? json({ ok: false, error: 'not_found' }, 404)
      : errorHtml(
          ['お申し込みが見つかりませんでした。お申し込み時のメールアドレス、または受付番号をご確認ください'],
          'お申し込みが見つかりません',
          404,
        );
  }

  /*
    **一度答えた案件を、メール一致だけで書き換えさせない。**

    メールアドレスは本人しか知らない情報ではない（名刺・SNS・過去のやり取り）。
    初回はそれで十分だが、既に回答が入っている案件まで上書きできると、
    予算や記念日を偽の値に差し替えられ、運営者がそれを信じて動くことになる。
    2回目以降は受付番号（推測できない8桁）を要求する。
    番号を無くした人は LINE で言ってもらえば、管理画面から直せる。
  */
  /**
   * 本人だと確認が取れているか。受付番号（推測できない）か、
   * **その案件に紐づいている LINE 本人のトークン**で来ていれば確認済みとみなす。
   */
  const verified = !!code || !!(lineUser && c.line_user_id === lineUser.user_id);

  if (!verified && c.survey_at) {
    console.warn(`[survey] 回答済みの案件をメール一致で更新しようとした ip=${ip} case=${c.id}`);
    return wantsJson
      ? json({ ok: false, error: 'needs_code' }, 409)
      : errorHtml(
          [
            'このお申し込みには既にご回答をいただいています。',
            '内容を変更したい場合は、受付確認メールに記載の受付番号からお進みいただくか、LINEでお知らせください。',
          ],
          'すでにご回答いただいています',
          409,
        );
  }

  const parsed = parseSurvey(raw);

  // ハニーポットに引っかかった＝bot。**成功したふりをして何も保存しない。**
  // エラーを返すと bot 側に「弾かれた」と分かって作りを変えられるため。
  if (!parsed.ok && parsed.spam) {
    console.warn(`[survey] ハニーポットで遮断 ip=${ip}`);
    return wantsJson
      ? json({ ok: true, code: c.code })
      : seeOther(`/survey?c=${encodeURIComponent(c.code)}&done=1`);
  }

  if (!parsed.ok) {
    return wantsJson
      ? json({ ok: false, errors: parsed.errors }, 400)
      : errorHtml(Object.values(parsed.errors), '入力に不備があります');
  }

  let updated: CaseRow | null;
  try {
    // 生の回答も一緒に渡す。設問を増やしたときに、列がまだ無くても値が残るように
    // submission_json の survey キーにぶら下げる（入口の回答と同じ考え方）。
    const rawSurvey: Record<string, unknown> = { ...raw };
    delete rawSurvey.website;
    // 本人確認トークンは案件の記録に残さない（管理画面に出しても使い道が無く、
    // CSV に出ると本人以外の目に触れる経路が増えるだけ）。
    delete rawSurvey.t;
    updated = await applySurvey(c.id, parsed.value, rawSurvey);
  } catch (e) {
    // ここだけは失敗を隠さない。保存できていないのに完了画面を出すと回答が消える。
    console.error(`[survey] 回答の保存に失敗 case=${c.id}`, e);
    return wantsJson
      ? json({ ok: false, error: 'server' }, 500)
      : errorHtml(['保存でエラーが発生しました。時間をおいて再度お試しください'], '保存できませんでした', 500);
  }

  // 照会と保存の間に案件が消えた（管理画面から削除した）ケース。作り直さず 404 に落とす。
  if (!updated) {
    console.error(`[survey] 保存直前に案件が消えた case=${c.id}`);
    return wantsJson
      ? json({ ok: false, error: 'not_found' }, 404)
      : errorHtml(['お申し込みが見つかりませんでした'], 'お申し込みが見つかりません', 404);
  }

  /*
    ── LINE との紐づけ ──

    **まっさらな組み合わせのときだけ自動で結ぶ。**
    案件にも LINE ユーザーにもまだ相手がいないなら、取り違えようがない
    （トークンはその人のトークにしか送っていない）。ここが自動化の本体で、
    これまで「友だち追加の通知を見て管理画面でワンタップ」していた手順が要らなくなる。

    どちらかが既に埋まっていて相手が違うときは**触らない**。
      - 案件に別の LINE が付いている … 取り違えたまま提案を送る事故になる
      - LINE が別の案件に付いている  … リピートの2件目かもしれないし、
                                       リンクを誰かに転送されただけかもしれない
    どちらも人が見れば1秒で分かるので、通知に書いて管理画面で決めてもらう。
  */
  const notes: string[] = [];
  if (createdFromLine) {
    notes.push('お申し込みが見つからなかったため、新しい案件として作成しました（重複していれば統合してください）');
  }
  if (lineUser) {
    try {
      const held = await findCaseByLineUser(lineUser.user_id);
      if (!updated.line_user_id && !held) {
        await linkLineUser(updated.id, lineUser.user_id, 'アンケートの案内リンクから自動で紐づけ');
        updated = (await getCase(updated.id)) ?? updated;
      } else if (updated.line_user_id !== lineUser.user_id) {
        notes.push(
          held
            ? `回答した LINE（${lineUser.display_name || '表示名なし'}）は別の案件 #${held.id}（${held.code}）に紐づいています。付け替えるかは管理画面で判断してください`
            : `この案件には別の LINE が紐づいています。回答したのは ${lineUser.display_name || '表示名なし'} です`,
        );
        await addCaseLog(
          updated.id,
          'note',
          `アンケートに回答した LINE（${lineUser.user_id}）と、この案件の紐づけが一致しない`,
        );
      }
    } catch (e) {
      console.error(`[survey] LINE の紐づけで例外 case=${updated.id}`, e);
    }
  }

  // ここから先は「送れなくても保存は成立している」。失敗しても応答は成功で返す。
  try {
    await notifySurvey(updated, notes);
  } catch (e) {
    console.error(`[survey] 運営者通知で例外 case=${updated.id}`, e);
  }

  // 完了表示は `/survey` 自身がクエリを見て出す（専用のサンクスページは作らない。
  // 回答は「送って終わり」ではなく後から直せる画面のほうが都合がよいため）。
  return wantsJson
    ? json({ ok: true, code: updated.code })
    : seeOther(`/survey?c=${encodeURIComponent(updated.code)}&done=1`);
};
