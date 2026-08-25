/**
 * PV計測ビーコン（POST /api/pv）。
 *
 * 記事ページは Cache-Control: s-maxage=60 でエッジに載るので、
 * サーバ側のレンダリング回数＝閲覧回数にならない。だから記事を描いた時ではなく、
 * ブラウザから叩かれるこのエンドポイントで数える（schema.sql の pageviews 参照）。
 *
 * **このAPIだけは認証を掛けられない**（公開ページの読者が叩くため）。
 * src/middleware.ts は `/api/*` を丸ごと Cloudflare Access の検証対象にしているが、
 * `/api/pv` だけは PUBLIC_API として例外に入れてある。あれを外すと
 * 本番のビーコンが 401 で弾かれ、PVが1件も記録されなくなる。
 *
 * 無認証で開く以上、書き込みは「安く・少なく」に倒す：
 *   1. ボディは 512 バイトまで。それ以上は読まずに捨てる
 *   2. slug の形式チェックを DB アクセスの前に置く（雑な文字列でクエリを打たせない）
 *   3. 同一IP＋同一slugの連打は 30 秒間まとめて1件にする
 * いずれも「本気の攻撃を止める仕掛け」ではなく、リロード連打や巡回で
 * D1 の書き込みが無駄に膨らむのを防ぐための下限の防御。本格的に狙われた場合は
 * Cloudflare 側の Rate Limiting Rules で落とすのが筋（Worker より前段で切れる）。
 */
import type { APIRoute } from 'astro';
import { getPublishedBySlug, recordPageview } from '../../lib/db';
import { isValidSlug } from '../../lib/frontmatter';

export const prerender = false;

/** slug1個の JSON しか受け付けないので、これで十分すぎるほど余裕がある。 */
const MAX_BODY_BYTES = 512;

/** 同一IP＋slugの重複を潰す窓。記事ページのエッジキャッシュ（60秒）の半分。 */
const DEDUPE_MS = 30_000;

/**
 * 重複判定のメモ。Worker のインスタンスが生きている間だけ効く best-effort な仕組みで、
 * インスタンスが複数ある本番では取りこぼす。それでも「1人が連打した分」は
 * だいたい同じインスタンスに当たるので、狙いの効果は出る。
 * KV や Durable Object を持ち出すほどの精度は PV には要らないと判断した。
 */
const recent = new Map<string, number>();
const DEDUPE_MAX_ENTRIES = 2000;

function seenRecently(key: string, now: number): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < DEDUPE_MS) return true;

  // 記録する前に、窓を抜けた分だけ掃除する（Map が青天井に伸びないように）。
  if (recent.size >= DEDUPE_MAX_ENTRIES) {
    for (const [k, t] of recent) {
      if (now - t >= DEDUPE_MS) recent.delete(k);
    }
    // 掃除しても減らない＝短時間に大量の別IPが来ている。
    // その状況で保持し続ける意味は薄いので捨てる（重複判定が甘くなるだけ）。
    if (recent.size >= DEDUPE_MAX_ENTRIES) recent.clear();
  }

  recent.set(key, now);
  return false;
}

/**
 * クライアントIP。Cloudflare を通れば CF-Connecting-IP が必ず付く
 * （本番は Worker が Cloudflare 経由でしか呼ばれないので実質これだけで足りる）。
 * astro dev には付かないので、その場合は固定キーに落として重複判定だけは効かせる。
 */
function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0]!.trim();
  return 'local';
}

/**
 * 何があっても 204 を返す。
 * 「存在しない slug」「下書きの slug」で応答を変えると、
 * 未公開記事の slug を総当たりで当てられてしまう。成否は読者に関係ない情報でもある。
 */
function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // Content-Length で門前払いできる分はボディを読む前に切る。
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return noContent();

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return noContent();
  }
  // Content-Length を詐称された場合の実測チェック（日本語は1文字3バイトなので長さで見る）。
  if (raw.length > MAX_BODY_BYTES) return noContent();

  let slug = '';
  try {
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === 'object' && 'slug' in data) {
      const v = (data as { slug: unknown }).slug;
      slug = typeof v === 'string' ? v.trim() : '';
    }
  } catch {
    return noContent();
  }

  // 形式が違う時点で DB には存在しないので、ここで打ち切る。
  if (!isValidSlug(slug)) return noContent();

  if (seenRecently(`${clientIp(request)}|${slug}`, Date.now())) return noContent();

  const article = await getPublishedBySlug(slug);
  if (!article) return noContent();

  await recordPageview(article.id);
  return noContent();
};
