/**
 * 書き上がった article.md を、記事エディタの下書きとして D1 に入れる。
 *
 *   node --experimental-strip-types scripts/put-draft.ts "記事/<KW名>/article.md"
 *
 * anniv-write-article の Step 6 から呼ぶ。今まではユーザーが管理画面を開いて本文欄に
 * 貼り付けていたが、貼るだけの作業を人がやる理由が無い。ここで下書きまで作っておき、
 * 人は「開いて slug を決めて公開する」だけにする。
 *
 * 経路は Cloudflare Access ではなく wrangler（＝ユーザーの Cloudflare ログイン）。
 * /api/articles を叩くには Access のサービストークンを発行してポリシーを足す必要があり、
 * 管理画面用に閉じてある口を機械のために開けることになる。D1 に直接書けば
 * 新しい認証経路も共有シークレットも増えない。
 *
 * 入れるのは必ず**下書き**。公開（slug の決定とレンダリング済みHTMLの確定）は
 * 管理画面の「公開する」に任せる——公開URLは後から変えられないので、
 * そこだけは人が見て決める（CLAUDE.md）。
 *
 * オプション：
 *   --local     ローカルの D1（astro dev 用）に入れる。既定は本番
 *   --slug xxx  slug も一緒に入れる（省略時は未設定のまま＝管理画面で決める）
 *   --dry-run   実行せず、流す SQL を表示するだけ
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArticle, isValidSlug, makePlaceholderSlug } from '../src/lib/frontmatter.ts';
import { renderArticle } from '../src/lib/markdown.ts';

const WRANGLER = resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
const DB_NAME = 'anniv';

interface Options {
  file: string;
  local: boolean;
  dryRun: boolean;
  slug: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: '', local: false, dryRun: false, slug: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.local = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--slug') opts.slug = (argv[++i] ?? '').trim();
    else if (!a.startsWith('--') && !opts.file) opts.file = a;
  }
  return opts;
}

function die(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

/** SQL の文字列リテラル。SQLite は '' で ' をエスケープする。 */
function lit(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * wrangler d1 execute を叩いて JSON を返す。
 * npx を経由せず node で bin を直に起動する（Windows のシェル引用符に巻き込まれないため）。
 */
function d1(sql: string, opts: Options): any[] {
  const args = ['d1', 'execute', DB_NAME, opts.local ? '--local' : '--remote', '--json'];
  let tmp = '';
  // 記事本文を含む SQL はコマンドライン長の上限に当たるのでファイル経由で渡す
  if (sql.length > 1000) {
    tmp = join(tmpdir(), `anniv-put-draft-${Date.now()}.sql`);
    writeFileSync(tmp, sql, 'utf8');
    args.push('--file', tmp);
  } else {
    args.push('--command', sql);
  }

  const res = spawnSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 消せなくても致命的ではない */
    }
  }
  if (res.status !== 0) {
    die(`D1 の実行に失敗した\n${res.stderr || res.stdout}`);
  }
  // --json でもバナーが混じることがあるので、最初の配列から読む
  const out = res.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) die(`D1 の応答を読めなかった\n${out}`);
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return die(`D1 の応答を読めなかった\n${out}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.file) {
  die('article.md のパスを渡すこと（例: node --experimental-strip-types scripts/put-draft.ts "記事/記念日 プレゼント/article.md"）');
}
if (opts.slug && !isValidSlug(opts.slug)) {
  die('--slug は半角英数とハイフンのみ（先頭・末尾はハイフン不可、80字以内）');
}

const source = readFileSync(resolve(opts.file), 'utf8');
const parsed = parseArticle(source);

if (parsed.bodyOnly) die(`${opts.file} に frontmatter が無い（title / description / keyword / axis / funnel が要る）`);

const missing: string[] = [];
if (!parsed.title) missing.push('title');
if (!parsed.description) missing.push('description');
if (!parsed.keyword) missing.push('keyword');
if (!parsed.axis) missing.push('axis');
if (!parsed.funnel) missing.push('funnel');
if (!parsed.body.trim()) missing.push('本文');
if (missing.length) die(`frontmatter に ${missing.join(' / ')} が無い（または値が解決できない）`);

// 保存時と同じレンダラーを通す。ここで body_html まで作っておけば、
// 管理画面を開いた瞬間からプレビューが本番と同じ見た目で出る。
const rendered = renderArticle(parsed.body);
const now = new Date().toISOString();

/* ── 同じKWの記事が既にあるか ── */
const found = d1(
  `SELECT id, slug, status FROM articles WHERE keyword = ${lit(parsed.keyword)} ORDER BY id LIMIT 1`,
  opts,
);
const existing = (found[0]?.results ?? [])[0] as
  | { id: number; slug: string; status: string }
  | undefined;

if (existing && existing.status === 'published') {
  die(
    `KW「${parsed.keyword}」は既に公開済み（id=${existing.id} / ${existing.slug}）。` +
      '公開記事を上書きしないので、管理画面から手で更新すること。',
  );
}

const cols = {
  title: lit(parsed.title),
  description: lit(parsed.description),
  keyword: lit(parsed.keyword),
  axis: lit(parsed.axis),
  funnel: lit(parsed.funnel),
  body_md: lit(parsed.body),
  body_html: lit(rendered.html),
  toc_json: lit(JSON.stringify(rendered.toc)),
  is_ad: parsed.isAd ? 1 : 0,
  now: lit(now),
};

const sql = existing
  ? `UPDATE articles SET
       title=${cols.title}, description=${cols.description}, keyword=${cols.keyword},
       axis=${cols.axis}, funnel=${cols.funnel}, body_md=${cols.body_md},
       body_html=${cols.body_html}, toc_json=${cols.toc_json}, is_ad=${cols.is_ad},
       ${opts.slug ? `slug=${lit(opts.slug)},` : ''}
       updated_at=${cols.now}
     WHERE id=${existing.id};`
  : `INSERT INTO articles
       (slug,title,description,keyword,axis,funnel,status,body_md,body_html,toc_json,hero_image,is_ad,published_at,updated_at,created_at)
     VALUES
       (${lit(opts.slug || makePlaceholderSlug())},${cols.title},${cols.description},${cols.keyword},
        ${cols.axis},${cols.funnel},'draft',${cols.body_md},${cols.body_html},${cols.toc_json},
        NULL,${cols.is_ad},NULL,${cols.now},${cols.now})
     RETURNING id;`;

if (opts.dryRun) {
  console.log(sql);
  process.exit(0);
}

const res = d1(sql, opts);
const id = existing ? existing.id : newArticleId(res);
if (!id) die('保存はできたが記事IDを取得できなかった。管理画面の一覧を確認すること。');

/**
 * INSERT した記事のID。
 * 本番（--remote）は meta.last_row_id を返すが、ローカルの miniflare は返さない。
 * どちらでも同じように動くよう RETURNING を第一手にして、駄目なら引き直す。
 */
function newArticleId(result: any[]): number {
  const returned = (result[0]?.results ?? [])[0]?.id;
  if (Number.isInteger(returned)) return returned as number;
  const lastRow = Number(result[0]?.meta?.last_row_id);
  if (Number.isInteger(lastRow) && lastRow > 0) return lastRow;
  const again = d1(
    `SELECT id FROM articles WHERE keyword=${lit(parsed.keyword)} ORDER BY id DESC LIMIT 1`,
    opts,
  );
  return Number((again[0]?.results ?? [])[0]?.id) || 0;
}

/*
 * キーワード台帳を「執筆中」に倒す（記事エディタの保存と同じ扱い）。
 * status を進めるのは todo のときだけ。done や dropped を巻き戻さない。
 */
d1(
  `UPDATE keywords SET status='writing', article_id=${id}, updated_at=${cols.now}
   WHERE keyword=${cols.keyword} AND status='todo';`,
  opts,
);

const base = opts.local ? 'http://localhost:4321' : 'https://anniv.gift';
console.log(existing ? `下書きを更新した（id=${id}）` : `下書きを作成した（id=${id}）`);
console.log(`  ${base}/admin/${id}/edit`);
console.log(`  KW: ${parsed.keyword} / 軸: ${parsed.axis} / ${[...parsed.body].length}字`);
if (!opts.slug) console.log('  slug は未設定。公開する前に管理画面で決めること。');
