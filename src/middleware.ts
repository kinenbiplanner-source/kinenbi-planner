/**
 * 管理画面（/admin）と API（/api）の認証。
 *
 * Cloudflare Access を前段に置き、そこが発行する JWT をここで必ず検証する。
 *
 * 「Access が守っているのだから中は素通しでいい」は成り立たない：
 * Access のパスポリシーは `anniv.gift/admin` にしか掛けていないため、
 * **`/api/*` はこのミドルウェアだけが防御線**になる。記事の作成・更新・削除・
 * R2 へのアップロードが全部 /api 配下にあるので、ここは手を抜かない。
 * （wrangler.jsonc で workers_dev を false にしているのも同じ理由で、
 *   *.workers.dev という Access を迂回する経路を塞ぐため。）
 *
 * 参考：Cloudflare Access の JWT は
 *   - ヘッダ `Cf-Access-Jwt-Assertion`（Access 経由なら必ず付く）
 *   - クッキー `CF_Authorization`（ブラウザのナビゲーションでは主にこちら）
 * の2経路で届く。両方見る。
 */
import { defineMiddleware } from 'astro:middleware';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from 'cloudflare:workers';

/** Access アプリの設定。両方揃って初めて検証できる。 */
interface AccessConfig {
  /** 例：your-team.cloudflareaccess.com（スキーム・末尾スラッシュ無し） */
  teamDomain: string;
  /** Access アプリの Application Audience (AUD) Tag */
  aud: string;
}

/**
 * 設定の取得元は Workers の環境変数（wrangler の vars / secret）。
 * ローカルの .dev.vars や .env から拾えるように import.meta.env も見る。
 * wrangler.jsonc に vars 定義を書いていない（＝生成型 Env に無い）ので、
 * 型は Record に落として読む。
 */
function readConfig(): AccessConfig | null {
  const fromWorker = env as unknown as Record<string, string | undefined> | undefined;
  const fromBuild = import.meta.env as unknown as Record<string, string | undefined>;

  const rawDomain = (fromWorker?.CF_ACCESS_TEAM_DOMAIN ?? fromBuild.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = (fromWorker?.CF_ACCESS_AUD ?? fromBuild.CF_ACCESS_AUD ?? '').trim();
  if (!rawDomain || !aud) return null;

  // `https://team.cloudflareaccess.com/` のように貼られても動くように正規化する。
  // issuer の比較は文字列一致なので、ここでブレを吸収しておかないと検証が落ちる。
  const teamDomain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return { teamDomain, aud };
}

/**
 * JWKS はモジュールスコープでキャッシュする。
 * createRemoteJWKSet の戻り値自体が内部にキャッシュと再取得（kid 未知のときだけ）の
 * ロジックを持っているので、リクエストごとに作り直すと毎回 certs を取りに行くことになる。
 * Worker のインスタンスが生きている間は使い回すのが正しい。
 */
let jwksCache: { domain: string; resolve: ReturnType<typeof createRemoteJWKSet> } | null = null;

function jwksFor(teamDomain: string) {
  if (!jwksCache || jwksCache.domain !== teamDomain) {
    jwksCache = {
      domain: teamDomain,
      resolve: createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)),
    };
  }
  return jwksCache.resolve;
}

/** ヘッダ優先、無ければクッキー。 */
function readToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header && header.trim()) return header.trim();

  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 保護対象の判定。
 *
 * build.format が 'file' なので、静的ルートは `/media.html` のような形でも届きうる。
 * `/api/articles.html` のような小細工で保護をすり抜けられないよう、
 * 末尾の `.html` とスラッシュを落としてから前方一致で見る。
 */
function isProtected(pathname: string): { protectedPath: boolean; api: boolean } {
  const path = pathname.replace(/\.html$/i, '').replace(/\/+$/, '') || '/';
  const api = path === '/api' || path.startsWith('/api/');
  const admin = path === '/admin' || path.startsWith('/admin/');
  return { protectedPath: api || admin, api };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

function htmlError(status: number, heading: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${heading}</title>` +
      `<style>body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#fafaf8;color:#2d3748;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
      `div{max-width:520px;background:#fff;border:1px solid #d1e8f5;border-radius:8px;padding:32px;` +
      `box-shadow:0 2px 12px rgba(26,40,64,.06)}h1{font-size:18px;color:#1a2840;margin:0 0 12px}` +
      `p{font-size:14px;line-height:1.9;margin:0}</style></head>` +
      `<body><div><h1>${heading}</h1><p>${body}</p></div></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
      },
    },
  );
}

/**
 * www は apex へ寄せる。
 * 旧本番（Vercel）も www.anniv.gift → anniv.gift へ飛ばしていたので挙動を引き継ぐ。
 * 旧本番は 307 だったが、ホスト名の正規化は恒久的な性質なので 301 にする
 * （www は元々正規URLではないため、301 に上げても既存の評価は動かない）。
 */
function wwwRedirect(url: URL): Response | null {
  if (url.hostname !== 'www.anniv.gift') return null;
  const target = new URL(url);
  target.hostname = 'anniv.gift';
  return Response.redirect(target.toString(), 301);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const www = wwwRedirect(context.url);
  if (www) return www;

  const { protectedPath, api } = isProtected(context.url.pathname);

  // 公開側（LP・/media・/media/img/*）は何もしない。
  // ここで即 return しておくことで、静的ページのプリレンダリング時に
  // Access の設定や env を触らずに済む。
  if (!protectedPath) return next();

  const config = readConfig();

  if (!config) {
    // 設定漏れの扱いは意図的に非対称にしている。
    // ローカル開発（astro dev）では Access が前段に居ないので検証しようがなく、
    // 毎回 JWT を用意させると開発が回らない → スキップして固定ユーザーを入れる。
    // 逆に本番で未設定のまま素通しにすると、記事の作成・削除 API が
    // 無認証で全世界に開くことになる。事故の向きが致命的なので、
    // 「設定が無い＝壊れている」とみなして必ず 500 で落とす。
    if (import.meta.env.DEV) {
      context.locals.user = { email: 'dev@localhost' };
      return next();
    }
    return api
      ? jsonError(500, 'CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD が未設定です')
      : htmlError(
          500,
          '設定エラー',
          'Cloudflare Access の設定（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD）が Worker に入っていません。' +
            '安全側に倒して管理画面を閉じています。',
        );
  }

  const token = readToken(context.request);
  if (!token) return deny(api);

  try {
    const { payload } = await jwtVerify(token, jwksFor(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.aud,
    });
    // 人間のログインなら email、サービストークンなら common_name が入る。
    const email =
      (typeof payload.email === 'string' && payload.email) ||
      (typeof payload.common_name === 'string' && payload.common_name) ||
      (typeof payload.sub === 'string' && payload.sub) ||
      'unknown';
    context.locals.user = { email };
    return next();
  } catch {
    // 失効・改竄・AUD 違いはすべてここ。理由は返さない（総当たりの手掛かりにしない）。
    return deny(api);
  }
});

function deny(api: boolean): Response {
  return api
    ? jsonError(401, '認証が必要です')
    : htmlError(
        403,
        'アクセスできません',
        'Cloudflare Access の認証が確認できませんでした。Access のポリシーが正しく設定されていれば、' +
          'このページに到達する前にログイン画面へ飛ぶはずです。' +
          'この画面が出る場合は Access アプリのパス設定か AUD タグを確認してください。',
      );
}
