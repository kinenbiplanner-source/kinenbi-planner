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
 *   --dry-run   実行せず、流す SQL と上げる画像を表示するだけ
 *   --no-images 本文のローカル画像を R2 に上げない（本文はローカルパスのまま）
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArticle, isValidSlug, makePlaceholderSlug } from '../src/lib/frontmatter.ts';
import { renderArticle } from '../src/lib/markdown.ts';

const WRANGLER = resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');
const DB_NAME = 'anniv';
const BUCKET = 'anniv-media';

interface Options {
  file: string;
  local: boolean;
  dryRun: boolean;
  slug: string;
  noImages: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: '', local: false, dryRun: false, slug: '', noImages: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.local = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-images') opts.noImages = true;
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

/* ── 記事内のローカル画像を R2 に上げて公開URLに差し替える ── */

/** 受け取る画像形式。管理画面の「画像をアップロード」（/api/upload）と同じ4種だけ。 */
const IMAGE_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
};

/** MIME から決め直す拡張子（.jpeg を .jpg に寄せる。/api/upload と同じ扱い）。 */
const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

/**
 * R2 のキー。/api/upload と同じ `YYYY/MM/<8文字>-<名前>.<ext>` に揃える。
 * 管理画面から上げた画像と同じ場所に並ぶので、R2 のコンソールで記事の時期から辿れる。
 */
function r2Key(filePath: string, type: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const token = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
  const base =
    basename(filePath, extname(filePath))
      .replace(/[^A-Za-z0-9._-]/g, '')
      .replace(/^[.-]+/, '')
      .slice(0, 60) || 'image';
  return `${yyyy}/${mm}/${token}-${base}${EXT_FOR_TYPE[type]}`;
}

/** R2 に1ファイル置く。経路は D1 と同じ wrangler。 */
function r2put(key: string, filePath: string, type: string, opts: Options): void {
  const res = spawnSync(
    process.execPath,
    [
      WRANGLER,
      'r2',
      'object',
      'put',
      `${BUCKET}/${key}`,
      '--file',
      filePath,
      '--content-type',
      type,
      opts.local ? '--local' : '--remote',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    die(`画像のアップロードに失敗した（${filePath}）\n${res.stderr || res.stdout}`);
  }
}

/**
 * 本文中のローカル画像参照（`![alt](images/card_01_x.webp)`）を R2 に上げ、
 * `/media/img/<key>` に差し替えた本文を返す。
 *
 * ローカルパスのまま D1 に入れると公開先で画像が壊れる——管理画面の公開前チェックが
 * ×で拾う項目でもある。人が編集画面で1枚ずつ上げ直す作業に意味は無いのでここでやる。
 * 差し替え後の本文で `article.md` も上書きするため、2回流しても二重には上がらない。
 *
 * `http(s)://` や `/` 始まり（＝既にR2にあるもの）と data URI には触らない。
 */
function uploadLocalImages(
  text: string,
  baseDir: string,
  opts: Options,
): { text: string; count: number } {
  const local = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((src) => !/^(https?:)?\//.test(src) && !src.startsWith('data:'));
  const unique = [...new Set(local)];
  if (!unique.length) return { text, count: 0 };

  let out = text;
  for (const src of unique) {
    const filePath = resolve(baseDir, src);
    if (!existsSync(filePath)) {
      die(`本文が参照している画像が見つからない: ${src}\n  探した場所: ${filePath}`);
    }
    const type = IMAGE_TYPES[extname(filePath).toLowerCase()];
    if (!type) die(`対応していない画像形式: ${src}（JPEG / PNG / WebP / AVIF のみ）`);

    const key = r2Key(filePath, type);
    if (!opts.dryRun) r2put(key, filePath, type, opts);
    console.log(`  ${opts.dryRun ? '上げる予定' : '上げた'}: ${src} -> /media/img/${key}`);
    // 参照は同じ画像を複数箇所から指していることがあるので全部置き換える
    out = out.split(`](${src})`).join(`](/media/img/${key})`);
  }
  return { text: out, count: unique.length };
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

// 要約カードなどのローカル画像を R2 に上げ、本文の参照を公開URLに差し替える。
// article.md 側も差し替え後の本文で上書きするので、次に流したときは何も上がらない。
let body = parsed.body;
if (!opts.noImages) {
  const articlePath = resolve(opts.file);
  const swapped = uploadLocalImages(source, dirname(articlePath), opts);
  if (swapped.count) {
    if (!opts.dryRun) writeFileSync(articlePath, swapped.text, 'utf8');
    body = parseArticle(swapped.text).body;
  }
}

// 保存時と同じレンダラーを通す。ここで body_html まで作っておけば、
// 管理画面を開いた瞬間からプレビューが本番と同じ見た目で出る。
const rendered = renderArticle(body);
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

/*
 * slug の重複チェック。D1 側も UNIQUE なので二重には入らないが、
 * そのまま流すと wrangler が制約違反を返すだけで「何とぶつかったのか」が出ない。
 * 管理画面は打っている最中に持ち主を教えてくれるので、こちらも同じ情報を出す。
 */
if (opts.slug) {
  const clash = d1(`SELECT id, title, status FROM articles WHERE slug = ${lit(opts.slug)} LIMIT 1`, opts);
  const owner = (clash[0]?.results ?? [])[0] as
    | { id: number; title: string; status: string }
    | undefined;
  if (owner && owner.id !== existing?.id) {
    die(
      `slug「${opts.slug}」は既に使われている` +
        `（id=${owner.id} / ${owner.status === 'published' ? '公開済み' : '下書き'} / ${owner.title}）。` +
        '公開URLは1記事に1つなので、別の slug にすること。',
    );
  }
}

const cols = {
  title: lit(parsed.title),
  description: lit(parsed.description),
  keyword: lit(parsed.keyword),
  axis: lit(parsed.axis),
  funnel: lit(parsed.funnel),
  body_md: lit(body),
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
console.log(`  KW: ${parsed.keyword} / 軸: ${parsed.axis} / ${[...body].length}字`);
if (!opts.slug) console.log('  slug は未設定。公開する前に管理画面で決めること。');
