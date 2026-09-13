/**
 * scripts/seo/*.ts が D1 を読み書きするための共通部品。
 *
 * 経路は put-draft.ts / update-pv.ts と同じで、wrangler（ユーザーの Cloudflare ログイン）で
 * 直接叩く。/api/keywords を curl で叩くには Access のサービストークンが要り、
 * 管理画面用に閉じてある口を機械のために開けることになるので、そうしない。
 *
 * 既存2本の d1Many を3つ目にコピーしないためのモジュール。既存2本は動いているものなので
 * ここへ寄せ直していない（触らない）。新しく書くスクリプトはこちらを使う。
 */
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeoArticle, SeoKeyword } from '../../src/lib/seo/types.ts';

/** リポジトリルート。どこから叩いても同じ場所を指す。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const DB_NAME = 'anniv';

export interface D1Opts {
  /** ローカルの D1（astro dev 用）。既定は本番 */
  local: boolean;
}

export function die(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

/** SQL の文字列リテラル。SQLite は '' で ' をエスケープする。 */
export function lit(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 複数の文をまとめて1回の wrangler で流し、文ごとの results を返す。
 * wrangler の起動が1回3〜5秒かかるので、クエリの数だけ起動しない。
 * SQL が長いときはファイル経由（コマンドライン長の上限）。
 */
export function d1Many(sqls: string[], opts: D1Opts): any[][] {
  if (sqls.length === 0) return [];
  const sql = sqls.map((s) => s.trim().replace(/;$/, '')).join(';\n') + ';';
  const args = ['d1', 'execute', DB_NAME, opts.local ? '--local' : '--remote', '--json'];
  let tmp = '';
  if (sql.length > 1000) {
    tmp = join(tmpdir(), `anniv-seo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
    writeFileSync(tmp, sql, 'utf8');
    args.push('--file', tmp);
  } else {
    args.push('--command', sql);
  }
  const res = spawnSync(process.execPath, [WRANGLER, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  // SQL のエラー本文は stdout（JSON）に出る。stderr には wrangler 終了時の libuv アサーションが
  // 混じることがあり、stderr を優先すると本当の原因が隠れる。両方出す（stdout が先）。
  if (res.status !== 0) {
    const parts = [res.stdout, res.stderr].map((s) => (s ?? '').trim()).filter(Boolean);
    die(`D1 の実行に失敗した（exit ${res.status}）\n${parts.join('\n--- stderr ---\n')}`);
  }
  const out = res.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) die(`D1 の応答を読めなかった\n${out}`);
  let parsed: any[];
  try {
    parsed = JSON.parse(out.slice(start));
  } catch {
    return die(`D1 の応答を読めなかった\n${out}`);
  }
  if (parsed.length !== sqls.length) die(`D1 の応答数が合わない（${sqls.length} 文を流して ${parsed.length} 件）`);
  return parsed.map((r) => r.results ?? []);
}

export function d1One(sql: string, opts: D1Opts): any[] {
  return d1Many([sql], opts)[0] ?? [];
}

/**
 * カニバリ判定と内部リンク提案の照合相手をまとめて引く。
 * 台帳は dropped も含めて全件（「見送った理由」を候補の横に出せるように）。
 * 記事は下書きも含める（下書き中のKWに新候補が重なるのは避けたい）。
 */
export function loadSeoCatalog(opts: D1Opts): { keywords: SeoKeyword[]; articles: SeoArticle[] } {
  const [kw, art] = d1Many(
    [
      `SELECT id, keyword, axis, funnel, status, article_id, COALESCE(seed, '') AS seed FROM keywords ORDER BY id`,
      `SELECT id, slug, title, keyword, axis, funnel, status, body_md FROM articles ORDER BY id`,
    ],
    opts,
  );
  return {
    keywords: (kw as any[]).map((r) => ({
      id: Number(r.id),
      keyword: String(r.keyword ?? ''),
      axis: String(r.axis ?? ''),
      funnel: String(r.funnel ?? ''),
      status: (r.status ?? 'todo') as SeoKeyword['status'],
      article_id: r.article_id === null || r.article_id === undefined ? null : Number(r.article_id),
      seed: String(r.seed ?? ''),
    })),
    articles: (art as any[]).map((r) => ({
      id: Number(r.id),
      slug: String(r.slug ?? ''),
      title: String(r.title ?? ''),
      keyword: String(r.keyword ?? ''),
      axis: String(r.axis ?? ''),
      funnel: String(r.funnel ?? ''),
      status: (r.status ?? 'draft') as SeoArticle['status'],
      body_md: String(r.body_md ?? ''),
    })),
  };
}

/** 共通オプションの取り出し。各スクリプトの parseArgs から呼ぶ。 */
export function takeCommonFlag(argv: string[], flag: string): boolean {
  const i = argv.indexOf(flag);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}
