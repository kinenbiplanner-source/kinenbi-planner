/**
 * `.dev.vars`（KEY=VALUE）を読む。scripts/seo/*.ts が外部 API の鍵を取るための共通部品。
 *
 * update-pv.ts の readDevVars と同じ作りだが、あちらは GA4 の3変数に固定している。
 * こちらは必要なキーを引数で受ける（Instagram の Graph API トークンなど、スクリプトごとに違う）。
 * 環境変数があればそちらが勝つ（CI や一時的な差し替え用）。
 *
 * 鍵は wrangler secret には入れない——競合の観測は Worker では動かさず、ローカルのスクリプトだけが叩く。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './_d1.ts';

const DEV_VARS = join(ROOT, '.dev.vars');

export function readDevVars(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(DEV_VARS)) {
    for (const raw of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      if (!keys.includes(k)) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  }
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** JST の今日（YYYY-MM-DD）。D1 の ymd 列と揃える。 */
export function jstToday(): string {
  const t = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}
