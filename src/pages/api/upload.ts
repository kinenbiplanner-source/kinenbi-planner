/**
 * 記事内画像のアップロード（POST /api/upload）。multipart/form-data の `file` を R2 へ。
 *
 * 受け取ったファイル名と Content-Type はどちらもクライアント申告なので信用しない：
 *   - MIME はホワイトリストで弾く（画像4種のみ）
 *   - 拡張子は申告された名前ではなく MIME から決め直す（.jpg を偽装した何かを防ぐ）
 *   - ファイル名は英数・ハイフン・アンダースコア・ドット以外を落とす
 * これで R2 のキーに変な文字やパス区切りが混ざらず、/media/img/<key> の配信も安全になる。
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/** 許可する MIME と、そこから決める拡張子。 */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

/** R2 の課金より先に記事の読み込み速度が死ぬので、8MB で頭打ちにする。 */
const MAX_BYTES = 8 * 1024 * 1024;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

/** 衝突回避用の短いランダム文字列（人が読める必要はないので base36）。 */
function randomToken(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** 拡張子を落とした上で安全な文字だけ残す。空になったら 'image'。 */
function sanitizeBaseName(name: string): string {
  const withoutExt = name.replace(/\.[^.]*$/, '');
  const cleaned = withoutExt
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[.-]+/, '')
    .slice(0, 60);
  return cleaned || 'image';
}

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'multipart/form-data で送ってください' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: 'file がありません' }, 400);

  const type = file.type.toLowerCase();
  const ext = ALLOWED[type];
  if (!ext) {
    return json({ error: '画像は JPEG / PNG / WebP / AVIF のみ対応しています' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: `ファイルが大きすぎます（上限 ${MAX_BYTES / 1024 / 1024}MB）` }, 413);
  }

  // YYYY/MM で切っておくと、R2 のコンソールで記事の時期から辿れる。
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `${yyyy}/${mm}/${randomToken()}-${sanitizeBaseName(file.name)}${ext}`;

  await env.MEDIA.put(key, await file.arrayBuffer(), {
    // ここで付けておかないと配信時に Content-Type が分からず、
    // /media/img/[...key].ts が octet-stream で返すことになる。
    httpMetadata: { contentType: type },
  });

  return json({ key, url: `/media/img/${key}` }, 201);
};
