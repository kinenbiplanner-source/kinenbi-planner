/**
 * Instagram カルーセル レンダラー（Anniv ブランド。1080×1350 の JPEG を吐く）
 *
 * 投稿台本の原稿を JSON にしてこれに食わせると、スライド画像が枚数ぶん出る。
 * 仕組みは card-renderer/render.py と同じ（Chrome headless で撮影 → sharp で切り出し・JPEG化）。
 * IG は JPEG しか受け付けないので JPEG 固定（SNS戦略.md 5章）。
 *
 * 見た目の芯は bg/light.png・bg/dark.png（ブランドの背景。ロゴ入り）。
 * 全スライドがこの2枚のどちらかを敷き、文字は背景の空いている場所に置く。
 * 写真は全面に敷かず、表紙の中央に金の輪で切り抜いた円セルとして置く。
 *   表紙 = dark ／ 本文 = light（長いものは "bg": "dark" で逃がせる）／ 締め = dark
 *
 *   node .claude/scripts/ig-renderer/render.mjs <spec.json>
 *
 * spec.json:
 * {
 *   "output_dir": "記事管理/SNS原稿/ig_2026-09-07",     // リポジトリルート基準 or 絶対パス
 *   "slides": [
 *     { "type": "cover", "photo": "素材/xxx.webp",
 *       "eyebrow": "小さい前置き", "title": ["1行目", "2行目"], "sub": "補足" },
 *     { "type": "body", "bg": "light|dark（既定 light）", "kicker": "推奨", "heading": "見出し（\n で改行）",
 *       "lead": "任意", "items": ["①の文", "②の文"], "paras": ["段落", "段落"], "note": "任意" },
 *     { "type": "table", "bg": "…", "kicker": "任意", "heading": "2万円の組み方（一例）",
 *       "rows": [["プレゼント本体", "12,000円"], ...], "total": ["合計", "20,000円"], "note": "※金額は一例" },
 *     { "type": "cta", "kicker": "任意", "heading": "締めの見出し", "paras": ["本文"],
 *       "cta_strong": "相談は無料・ご入金前のキャンセルも無料", "cta": "プロフィールのリンクからどうぞ" }
 *   ]
 * }
 *
 * 本文の **強調** は下線ハイライトになる。
 * 出力: <output_dir>/1.jpg .. N.jpg（既存は上書き）
 * 文字が背景の安全域（light は y900 まで）からはみ出すと stderr に警告を出す。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const TPL = readFileSync(path.join(HERE, 'template.html'), 'utf8')
  .replace('__BG_LIGHT__', pathToFileURL(path.join(HERE, 'bg', 'light.png')).href)
  .replace('__BG_DARK__', pathToFileURL(path.join(HERE, 'bg', 'dark.png')).href);

const W = 1080;
const H = 1350;
const SCALE = 2;              // 2倍で撮って 1080×1350 に落とす（文字のエッジが締まる）
const OVERHEAD_PAD = 200;     // headless=new はウィンドウ枠ぶん viewport が縮む。余分に撮って上から切る
const PER_SHOT = 4;           // 1回の撮影に積むスライド数（縦 2700×4 = 10800px。GPU のテクスチャ上限 16384 を超えない）

function findChrome() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return c.find((p) => existsSync(p)) ?? c[0];
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// **強調** → <strong>、\n → <br>
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function resolveAsset(p) {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!existsSync(abs)) throw new Error(`asset not found: ${abs}`);
  return pathToFileURL(abs).href;
}

const bgClass = (s, def) => (s.bg === 'dark' || s.bg === 'light') ? s.bg : def;
const kickerRow = (k, i, n) =>
  `<div class="kicker-row"><span class="kicker">${k ? esc(k) : ''}</span><span class="page">${i} / ${n}</span></div>`;
const paras = (list) => list?.length ? `<div class="paras">${list.map((t) => `<div class="para">${rich(t)}</div>`).join('')}</div>` : '';

function slideCover(s) {
  const title = (Array.isArray(s.title) ? s.title : [s.title]).map(rich).join('<br>');
  return `<div class="slide dark cover">
  <div class="cell"><img src="${resolveAsset(s.photo)}"></div>
  <div class="text">
    ${s.eyebrow ? `<div class="eyebrow">${esc(s.eyebrow)}</div>` : ''}
    <h1>${title}</h1>
    ${s.sub ? `<div class="sub">${rich(s.sub)}</div>` : ''}
  </div>
</div>`;
}

function slideBody(s, i, n) {
  const parts = [kickerRow(s.kicker, i, n), `<h1>${rich(s.heading)}</h1><div class="rule"></div>`];
  if (s.lead) parts.push(`<div class="lead">${rich(s.lead)}</div>`);
  if (s.items?.length) {
    parts.push(`<div class="items">${s.items.map((t, k) =>
      `<div class="item"><span class="num">${CIRCLED[k] ?? k + 1}</span><span>${rich(t)}</span></div>`).join('')}</div>`);
  }
  parts.push(paras(s.paras));
  if (s.note) parts.push(`<div class="note">${rich(s.note)}</div>`);
  return `<div class="slide ${bgClass(s, 'light')}"><div class="content" data-guard>${parts.join('')}</div></div>`;
}

function slideTable(s, i, n) {
  const rows = s.rows.map(([l, a]) => `<div class="row"><span>${esc(l)}</span><span class="amt">${esc(a)}</span></div>`);
  if (s.total) rows.push(`<div class="row total"><span>${esc(s.total[0])}</span><span class="amt">${esc(s.total[1])}</span></div>`);
  return `<div class="slide ${bgClass(s, 'light')}"><div class="content" data-guard>
    ${kickerRow(s.kicker, i, n)}
    <h1>${rich(s.heading)}</h1><div class="rule"></div>
    <div class="table">${rows.join('')}</div>
    ${s.note ? `<div class="note">${rich(s.note)}</div>` : ''}
  </div></div>`;
}

function slideCta(s, i, n) {
  return `<div class="slide ${bgClass(s, 'dark')}"><div class="content">
    ${kickerRow(s.kicker, i, n)}
    <h1>${rich(s.heading)}</h1><div class="rule"></div>
    ${paras(s.paras)}
    <div class="grow"></div>
    <div class="ctabox">
      ${s.cta_strong ? `<div class="strong">${esc(s.cta_strong)}</div>` : ''}
      <div>${rich(s.cta ?? 'プロフィールのリンクからどうぞ')}</div>
    </div>
  </div></div>`;
}

const BUILDERS = { cover: slideCover, body: slideBody, table: slideTable, cta: slideCta };

/* 本文が安全域からはみ出していないかを、撮影後に画面上で測ってページに書き出す。
   （.content の scrollHeight と箱の高さを比べるだけ。Chrome の --dump-dom で拾う） */
const GUARD_SCRIPT = `<script>
window.addEventListener('load', () => {
  const out = [];
  document.querySelectorAll('.slide').forEach((sl, k) => {
    const c = sl.querySelector('.content');
    if (!c) return;
    const box = c.getBoundingClientRect();
    const over = c.scrollHeight - box.height;
    if (over > 0) out.push('slide ' + (k + 1) + ': overflow ' + Math.round(over) + 'px');
  });
  document.title = out.length ? 'OVERFLOW ' + out.join(' | ') : 'OK';
});
</script>`;

async function shoot(html, count, chrome) {
  const tmpHtml = path.join(tmpdir(), `ig-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  const tmpPng = tmpHtml.replace(/\.html$/, '.png');
  writeFileSync(tmpHtml, html, 'utf8');
  const common = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${W},${H * count + OVERHEAD_PAD}`,
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=6000',
  ];
  const r = spawnSync(chrome, [...common, `--screenshot=${tmpPng}`, pathToFileURL(tmpHtml).href], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(tmpPng)) {
    unlinkSync(tmpHtml);
    throw new Error(`chrome failed (${r.status}): ${r.stderr}`);
  }
  // はみ出し検査（DOM を吐かせて <title> を読む）
  const d = spawnSync(chrome, [...common, '--dump-dom', pathToFileURL(tmpHtml).href], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = /<title>(.*?)<\/title>/s.exec(d.stdout ?? '');
  unlinkSync(tmpHtml);
  return { png: tmpPng, guard: m ? m[1] : '' };
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) { console.error('usage: node render.mjs <spec.json>'); process.exit(1); }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const outDir = path.isAbsolute(spec.output_dir) ? spec.output_dir : path.join(ROOT, spec.output_dir);
  mkdirSync(outDir, { recursive: true });
  const chrome = findChrome();
  const n = spec.slides.length;

  const htmls = spec.slides.map((s, idx) => {
    const b = BUILDERS[s.type];
    if (!b) throw new Error(`unknown slide type: ${s.type}`);
    return b(s, idx + 1, n);
  });

  const outputs = [];
  for (let start = 0; start < n; start += PER_SHOT) {
    const batch = htmls.slice(start, start + PER_SHOT);
    const { png, guard } = await shoot(TPL.replace('__SLIDES__', batch.join('\n') + GUARD_SCRIPT), batch.length, chrome);
    if (guard.startsWith('OVERFLOW')) {
      console.error(`warning: ${guard.replace(/slide (\d+)/g, (_, k) => `slide ${start + Number(k)}`)}`);
    }
    const meta = await sharp(png).metadata();
    for (let k = 0; k < batch.length; k++) {
      const top = k * H * SCALE;
      if (top + H * SCALE > meta.height) throw new Error(`screenshot too short: ${meta.height}px, need ${top + H * SCALE}`);
      const out = path.join(outDir, `${start + k + 1}.jpg`);
      await sharp(png)
        .extract({ left: 0, top, width: W * SCALE, height: H * SCALE })
        .resize(W, H)
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toFile(out);
      outputs.push(out);
    }
    unlinkSync(png);
  }
  for (const o of outputs) console.log(o);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
