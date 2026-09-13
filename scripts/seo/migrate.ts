/**
 * migrations/*.sql を D1 に当てる（ADD COLUMN 専用）。
 *
 *   node --experimental-strip-types scripts/seo/migrate.ts            # 本番
 *   node --experimental-strip-types scripts/seo/migrate.ts --local    # astro dev 用のローカル D1
 *   node --experimental-strip-types scripts/seo/migrate.ts --dry-run  # 足す列を表示するだけ
 *
 * SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無く、2回流すと落ちる。
 * ここでは PRAGMA table_info で今ある列を見て、**無い列の ALTER だけ**流す。
 * 何度流しても安全。schema.sql（新規作成用）と migrations/（既存に足す用）の両方を
 * 直すのが手順で、片方だけだと新規環境と既存環境で列がズレる。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, d1Many, d1One, die, takeCommonFlag } from './_d1.ts';

const MIGRATIONS_DIR = join(ROOT, 'migrations');
const ALTER_RE = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(.+?);?\s*$/i;

const argv = process.argv.slice(2);
const local = takeCommonFlag(argv, '--local');
const dryRun = takeCommonFlag(argv, '--dry-run');
if (argv.length) die(`知らないオプション: ${argv.join(' ')}`);
const opts = { local };

interface Alter {
  file: string;
  table: string;
  column: string;
  sql: string;
}

const alters: Alter[] = [];
for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  for (const raw of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    const m = line.match(ALTER_RE);
    if (!m) die(`${file}: ADD COLUMN 以外の文がある（このスクリプトは列追加しか扱わない）: ${line}`);
    alters.push({ file, table: m[1]!, column: m[2]!, sql: line.replace(/;$/, '') });
  }
}
if (alters.length === 0) die('migrations/ に ALTER 文が無い');

const tables = [...new Set(alters.map((a) => a.table))];
const existing = new Map<string, Set<string>>();
for (const t of tables) {
  const rows = d1One(`PRAGMA table_info(${t})`, opts) as Array<{ name: string }>;
  if (rows.length === 0) die(`テーブル ${t} が無い（先に npm run db:${local ? 'local' : 'remote'} で schema.sql を流す）`);
  existing.set(t, new Set(rows.map((r) => r.name)));
}

const todo = alters.filter((a) => !existing.get(a.table)!.has(a.column));
const skip = alters.length - todo.length;
console.log(`対象: ${local ? 'ローカル' : '本番'} D1 / 列追加 ${todo.length} 件（既にある ${skip} 件は飛ばす）`);
for (const a of todo) console.log(`  + ${a.table}.${a.column}   （${a.file}）`);
if (todo.length === 0) process.exit(0);
if (dryRun) {
  console.log('--dry-run なので流さない');
  process.exit(0);
}
d1Many(
  todo.map((a) => a.sql),
  opts,
);
console.log('完了');
