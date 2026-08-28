/**
 * 要約カードPNG → WebP 変換（anniv-write-article Step 6-2 の仕上げ）。
 *
 * render.py は 2x スケールのPNG（1枚 500KB〜700KB）を吐く。そのままR2へ上げると
 * 記事1本で数MBになり、SEOで効いてくるLCPを自分で悪化させる。可逆である必要は
 * 無い画像なので WebP(q82) に落とす。実測で 1/10 前後になる。
 *
 * 依存は sharp（このリポジトリの dependencies に既にある）。
 *
 *   node .claude/scripts/card-renderer/to_webp.mjs <png...> [--keep]
 *
 * 変換後、元のPNGは削除する（--keep で残す）。stdout に .webp のパスを出す。
 */
import { unlink } from 'node:fs/promises';
import sharp from 'sharp';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('usage: node to_webp.mjs <png...> [--keep]');
  process.exit(1);
}

for (const src of files) {
  const out = src.replace(/\.png$/i, '.webp');
  await sharp(src).webp({ quality: 82 }).toFile(out);
  if (!keep) await unlink(src);
  console.log(out);
}
