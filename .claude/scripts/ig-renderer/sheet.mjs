/**
 * 確認用のコンタクトシート。複数の投稿フォルダの 1.jpg..N.jpg を横に並べて 1枚の PNG にする。
 * 「カルーセルどうしの統一感」を見るためのもので、投稿には使わない。
 *
 *   node .claude/scripts/ig-renderer/sheet.mjs <out.png> <dir1> [dir2 ...]
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const [out, ...dirs] = process.argv.slice(2);
if (!out || dirs.length === 0) { console.error('usage: sheet.mjs <out.png> <dir...>'); process.exit(1); }

const TW = 240, TH = 300, GAP = 12, PAD = 24;
const rows = dirs.map((d) => readdirSync(d).filter((f) => /^\d+\.jpg$/.test(f))
  .sort((a, b) => parseInt(a) - parseInt(b)).map((f) => path.join(d, f)));
const cols = Math.max(...rows.map((r) => r.length));
const W = PAD * 2 + cols * TW + (cols - 1) * GAP;
const H = PAD * 2 + rows.length * TH + (rows.length - 1) * GAP;

const composites = [];
for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < rows[r].length; c++) {
    const buf = await sharp(rows[r][c]).resize(TW, TH).toBuffer();
    composites.push({ input: buf, left: PAD + c * (TW + GAP), top: PAD + r * (TH + GAP) });
  }
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#e9e9e6' } })
  .composite(composites).png().toFile(out);
console.log(out);
