/**
 * Worker の環境変数を読む小さな窓口。
 *
 * 取得元は `cloudflare:workers` の env（wrangler の vars / secret）。ローカルの .dev.vars や
 * .env から拾えるように import.meta.env も見る。wrangler.jsonc に vars を書いていない名前は
 * 生成型 Env に無いので Record に落として読む（src/middleware.ts と同じやり方）。
 *
 * ここに無い設定名を各所で直接 env から読まない。名前の typo が実行時まで分からなくなるため、
 * 読みたい変数はこのファイルの関数を通す。
 */
import { env } from 'cloudflare:workers';

export function readVar(name: string): string {
  const fromWorker = env as unknown as Record<string, string | undefined> | undefined;
  const fromBuild = import.meta.env as unknown as Record<string, string | undefined>;
  return (fromWorker?.[name] ?? fromBuild[name] ?? '').trim();
}

/** 本番URL。メールのリンクなどに使う。 */
export function siteUrl(): string {
  return readVar('SITE_URL') || 'https://anniv.gift';
}

/** 受付通知の宛先（運営者）。 */
export function ownerEmail(): string {
  return readVar('OWNER_EMAIL') || 'kinenbi.planner@gmail.com';
}

/** LINE 公式アカウントの友だち追加URL（lin.ee）。サンクスページと同じもの。 */
export function lineAddUrl(): string {
  return readVar('LINE_ADD_URL') || 'https://lin.ee/U4deTzi';
}

/** LINE 公式アカウントのベーシックID（@付き）。空なら oaMessage リンクは作れない。 */
export function lineOaId(): string {
  const v = readVar('LINE_OA_ID');
  if (!v) return '';
  return v.startsWith('@') ? v : `@${v}`;
}
