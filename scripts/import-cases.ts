/**
 * Notion の案件管理DB（CSV エクスポート）を D1 の cases に取り込む。
 *
 *   node --experimental-strip-types scripts/import-cases.ts "<Notion から書き出した .csv>" [--local] [--dry-run]
 *
 * Tally → Notion の運用をやめて D1（/admin/cases）に一本化するときに、
 * これまでの案件を移すための一回きりのスクリプト。列名は `notion_案件管理DB.csv`（このリポジトリの
 * 雛形）と同じ想定。Notion 側で列を足していても、知らない列は submission_json に生のまま残る。
 *
 * 同じ「メール＋記念日」の行が既に cases にあれば飛ばす（2回流しても増えない）。
 * 受付番号（code）は新しく採番する。旧 Notion の案件ID（#001 など）と担当者はメモに残す。
 *
 * D1 へは wrangler（ユーザーの Cloudflare ログイン）で直接書く。put-draft.ts と同じ経路。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WRANGLER = resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
const DB_NAME = 'anniv';

interface Options {
  file: string;
  local: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: '', local: false, dryRun: false };
  for (const a of argv) {
    if (a === '--local') opts.local = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (!a.startsWith('--') && !opts.file) opts.file = a;
  }
  return opts;
}

function die(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

/* ── CSV ── */

/** RFC4180 ざっくり準拠。引用符の中の改行とカンマ、"" のエスケープを扱う。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** ヘッダの揺れ（前後の空白・全角括弧の注記）を吸収するために正規化する。 */
function normHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().replace(/[（(].*$/, '');
}

/* ── 値の正規化 ── */

function yes(v: string): 0 | 1 {
  const s = v.trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '✓' || s === '1' || s === 'はい' || s === '済' ? 1 : 0;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

/** 2026-05-28 / 2026/5/28 / May 28, 2026 / 2026年5月28日 → YYYY-MM-DD。読めなければ ''。 */
function ymd(v: string): string {
  const s = v.trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  return '';
}

function jstMidnightIso(ymdStr: string): string {
  return new Date(`${ymdStr}T00:00:00+09:00`).toISOString();
}

const STATUS_MAP: Array<[RegExp, string]> = [
  [/キャンセル|失注|取消|辞退/, 'lost'],
  [/完了|フォロー済/, 'followed'],
  [/納品/, 'delivered'],
  [/手配/, 'arranging'],
  [/入金|決済済/, 'paid'],
  [/請求|決済リンク|送付済/, 'invoiced'],
  [/提案/, 'proposed'],
  [/ヒアリング/, 'hearing'],
  [/連絡済|初回連絡/, 'contacted'],
  [/受付|新規/, 'new'],
];

function mapStatus(v: string): string {
  for (const [re, s] of STATUS_MAP) if (re.test(v)) return s;
  return 'new';
}

function mapPaymentStatus(v: string): string {
  if (/返金/.test(v)) return 'refunded';
  if (/入金|決済済|支払済/.test(v)) return 'paid';
  if (/送付済|請求済/.test(v)) return 'sent';
  return 'none';
}

function mapPaymentMethod(v: string): string {
  const s = v.toLowerCase();
  if (s.includes('stripe') || s.includes('カード')) return 'stripe';
  if (s.includes('paypay')) return 'paypay';
  if (s.includes('振込') || s.includes('銀行')) return 'bank';
  return s ? 'other' : 'stripe';
}

/** 0/O、1/I/L を除いた 31 文字（src/lib/cases.ts の generateCode と同じ）。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(): string {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[b[i]! % CODE_ALPHABET.length];
    if (i === 3) s += '-';
  }
  return s;
}

/** SQL の文字列リテラル。SQLite は '' で ' をエスケープする。 */
function lit(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/* ── D1 ── */

function d1(sql: string, opts: Options): any[] {
  const args = ['d1', 'execute', DB_NAME, opts.local ? '--local' : '--remote', '--json'];
  let tmp = '';
  if (sql.length > 1000) {
    tmp = join(tmpdir(), `anniv-import-cases-${Date.now()}.sql`);
    writeFileSync(tmp, sql, 'utf8');
    args.push('--file', tmp);
  } else {
    args.push('--command', sql);
  }
  const res = spawnSync(process.execPath, [WRANGLER, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  if (res.status !== 0) die(`D1 の実行に失敗した\n${res.stderr || res.stdout}`);
  const out = res.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) die(`D1 の応答を読めなかった\n${out}`);
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return die(`D1 の応答を読めなかった\n${out}`);
  }
}

/* ── 本体 ── */

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) die('CSV ファイルを指定してください');

  const text = readFileSync(opts.file, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  if (rows.length < 2) die('CSV にデータ行がありません');
  const header = rows[0]!.map(normHeader);
  const col = (name: string): number => header.indexOf(name);
  const get = (row: string[], name: string): string => {
    const i = col(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  for (const required of ['顧客名']) {
    if (col(required) < 0) die(`ヘッダに「${required}」がありません（ヘッダ: ${header.join(', ')}）`);
  }

  // 既存の（メール＋記念日）を引いて重複を避ける
  const existing = new Set<string>();
  if (!opts.dryRun) {
    const res = d1('SELECT email, anniversary_date FROM cases', opts);
    for (const r of res[0]?.results ?? []) existing.add(`${r.email}|${r.anniversary_date}`);
  }

  const now = new Date().toISOString();
  const sqls: string[] = [];
  let skipped = 0;
  const summary: string[] = [];

  for (const row of rows.slice(1)) {
    const name = get(row, '顧客名') || get(row, '氏名') || get(row, 'お名前');
    if (!name) continue;
    const email = get(row, 'メールアドレス').toLowerCase();
    const annDate = ymd(get(row, '記念日'));
    const key = `${email}|${annDate}`;
    if (email && existing.has(key)) {
      skipped++;
      continue;
    }
    existing.add(key);

    const appliedOn = ymd(get(row, '申し込み日'));
    const createdAt = appliedOn ? jstMidnightIso(appliedOn) : now;
    const oldId = get(row, '案件ID');
    const assignee = get(row, '担当コンシェルジュ');
    const memoParts = [
      oldId ? `旧Notion案件ID: ${oldId}` : '',
      assignee ? `担当: ${assignee}` : '',
      get(row, 'メモ'),
    ].filter(Boolean);
    const amountRaw = get(row, '決済金額').replace(/[^\d]/g, '');
    const amount = amountRaw ? Number(amountRaw) : 0;

    const raw: Record<string, string> = {};
    header.forEach((h, i) => {
      raw[h] = row[i] ?? '';
    });

    const code = generateCode();
    sqls.push(
      `INSERT INTO cases (code, kind, status, name, email, line_name, anniversary_date, express,
         submission_json, source, plan, gift, gift_arranged, gift_shipped_on, restaurant, restaurant_booked,
         guide_sent, payment_method, payment_status, amount, memo, created_at, updated_at)
       VALUES (${lit(code)}, 'apply', ${lit(mapStatus(get(row, 'ステータス')))}, ${lit(name)}, ${lit(email)},
         ${lit(get(row, 'LINE名'))}, ${lit(annDate)}, ${yes(get(row, '特急オプション'))},
         ${lit(JSON.stringify(raw))}, 'other', ${lit(get(row, 'プラン'))}, ${lit(get(row, 'プレゼント内容'))},
         ${yes(get(row, 'プレゼント手配済'))}, ${lit(ymd(get(row, 'プレゼント発送日')))}, ${lit(get(row, 'レストラン店名'))},
         ${yes(get(row, 'レストラン予約済'))}, ${yes(get(row, '指示書送付済'))},
         ${lit(mapPaymentMethod(get(row, '決済方法')))}, ${lit(mapPaymentStatus(get(row, '決済ステータス')))},
         ${amount}, ${lit(memoParts.join('\n'))}, ${lit(createdAt)}, ${lit(now)})`,
    );
    sqls.push(
      `INSERT INTO case_log (case_id, kind, body, created_at)
       VALUES ((SELECT id FROM cases WHERE code=${lit(code)}), 'created', ${lit(`Notion から取り込み${oldId ? `（${oldId}）` : ''}`)}, ${lit(now)})`,
    );
    summary.push(`${code}  ${name}  ${annDate || '日付なし'}  ${mapStatus(get(row, 'ステータス'))}`);
  }

  if (sqls.length === 0) {
    console.log(`取り込む行がありません（重複で飛ばした: ${skipped} 件）`);
    return;
  }

  console.log(`取り込み ${summary.length} 件（重複で飛ばした: ${skipped} 件）`);
  for (const s of summary) console.log('  ' + s);

  if (opts.dryRun) {
    console.log('\n--dry-run のため実行していません。流す SQL:\n');
    console.log(sqls.join(';\n') + ';');
    return;
  }

  // 1回の wrangler でまとめて流す（文ごとに起動すると遅い）
  d1(sqls.join(';\n') + ';', opts);
  console.log(`\n完了。${opts.local ? 'ローカル' : '本番'}の /admin/cases に出ます。`);
}

main();
