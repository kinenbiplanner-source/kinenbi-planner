/**
 * multi-SNS-manager（別プロジェクト。本番 https://anniv-tool.date）が記録している
 * 運用コストを読む。/dashboard のコスト欄に「今月いくら使ったか」を出すためだけの層。
 *
 * ## なぜ API ではなく D1 を直接読むのか
 *
 * あちらは better-auth のセッション認証なので、こちらのブラウザから API を叩いても
 * クロスサイトでクッキーが飛ばない。サーバ間で叩くなら共有シークレットを両側に置く
 * 必要があり、**個人運用のダッシュボードに出すだけの数字に対して仕掛けが重すぎる**。
 * 同じ Cloudflare アカウントなら Worker から別プロジェクトの D1 をバインドできるので、
 * 読み取り専用でそれを使う（wrangler.jsonc の `SNS_DB`）。
 *
 * ## 代わりに引き受けている前提
 *
 * - **あちらのスキーマに依存する**（`cost_events` / `cost_settings`。定義は
 *   `C:\dev\multi-SNS-manager\src\db\schema\cost.ts` が正）。列名が変わればここは壊れる。
 *   壊れたときに /dashboard 全体が落ちないよう、**このモジュールは例外を投げない**。
 *   読めなければ `available: false` を返し、画面は「—」を出す
 * - 金額は **micro USD の整数**（1 USD = 1,000,000）。丸め誤差を持ち込まないため、
 *   円換算まで整数のまま運ぶ（あちらの `src/server/cost/money.ts` と同じやり方）
 * - **書き込みは絶対にしない。** ここから触っていいのは SELECT だけ
 */
import { env } from 'cloudflare:workers';

/** 1 USD = 1,000,000 micro USD（あちらの MICRO_USD_PER_USD と対） */
const MICRO_USD_PER_USD = 1_000_000;
/** `cost_settings.usd_jpy_rate_micro` の倍率 */
const RATE_SCALE = 1_000_000;

/**
 * 円換算のレートの既定値（あちらの DEFAULT_USD_JPY_RATE_MICRO と同じ 155円/ドル）。
 *
 * **固定費の既定値（Workers Paid $5 / ドメイン $0.85）はここに持たない。**
 * あちらは `cost_settings` の行が無いとき既定値で表示するが、それは「想定月額」であって
 * 実際の請求ではない。この画面は「今いくら出ていくか」を見るためのものなので、
 * 設定されていない固定費を勝手に積むと**払っていない金額が出る**（現に Anniv 側は
 * Cloudflare を無料枠で回している）。設定行があるときだけ固定費を足す。
 */
const DEFAULT_RATE_MICRO = 155_000_000;

/** 表示用の名前。あちらの COST_PLATFORMS と対。未知の値はそのまま出す。 */
const PLATFORM_LABELS: Record<string, string> = {
  x: 'X（投稿API）',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  meta_ads: 'Meta広告',
  cloudflare: 'Cloudflare',
};

export interface SnsCostPlatformRow {
  platform: string;
  label: string;
  microUsd: number;
  jpy: number;
  /** 件数（投稿数など）。固定費の行には無い */
  quantity: number;
}

export interface SnsCostSummary {
  available: boolean;
  /** 読めなかった理由（画面には出さない。ログ・調査用） */
  reason?: string;
  /** JST の YYYY-MM */
  month: string;
  /** イベント（従量課金・広告費）の合計 */
  eventsMicroUsd: number;
  /** 固定費（Workers Paid ＋ ドメイン）。cost_settings に行があるときだけ入る */
  fixedMicroUsd: number;
  /** 固定費が設定済みか。false なら「未設定なので積んでいない」（0円という意味ではない） */
  fixedConfigured: boolean;
  totalMicroUsd: number;
  totalJpy: number;
  /** 実額が取れている分（いまのところ Meta 広告だけ）。残りは推定値 */
  actualMicroUsd: number;
  byPlatform: SnsCostPlatformRow[];
  /** 1 USD = 何円で換算したか（画面に出して、円の数字が推定であることを示す） */
  usdJpyRate: number;
}

/**
 * JST の当月の範囲。`cost_events.occurred_at` は UTC エポックms なので、
 * JST の月初・翌月初を ms に直して半開区間 [start, end) で引く
 * （あちらの `src/server/cost/month.ts` と同じ切り方）。
 */
export function jstMonthRange(now: Date = new Date()): { startMs: number; endMs: number; month: string } {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  return {
    startMs: Date.UTC(y, m, 1) - 9 * 3_600_000,
    endMs: Date.UTC(y, m + 1, 1) - 9 * 3_600_000,
    month: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

/**
 * micro USD → 円。
 *
 * 掛け算だけ BigInt に逃がす。$1,000 × 155円 は 1.55e17 で
 * Number.MAX_SAFE_INTEGER（約9.0e15）を超え、黙って桁が落ちるため
 * （あちらの money.ts と同じ理由）。
 */
export function microUsdToJpy(microUsd: number, usdJpyRateMicro: number): number {
  const scaled = BigInt(Math.trunc(microUsd)) * BigInt(Math.trunc(usdJpyRateMicro));
  const divisor = BigInt(MICRO_USD_PER_USD) * BigInt(RATE_SCALE);
  const half = divisor / 2n;
  const rounded = scaled >= 0n ? (scaled + half) / divisor : -((-scaled + half) / divisor);
  return Number(rounded);
}

/** バインディングが無い環境（ローカルの astro dev など）もあるので optional で受ける。 */
function snsDb(): D1Database | null {
  const bound = (env as unknown as { SNS_DB?: D1Database }).SNS_DB;
  return bound ?? null;
}

function unavailable(reason: string, month: string): SnsCostSummary {
  return {
    available: false,
    reason,
    month,
    eventsMicroUsd: 0,
    fixedMicroUsd: 0,
    fixedConfigured: false,
    totalMicroUsd: 0,
    totalJpy: 0,
    actualMicroUsd: 0,
    byPlatform: [],
    usdJpyRate: DEFAULT_RATE_MICRO / RATE_SCALE,
  };
}

/**
 * 今月の運用コスト。
 *
 * ## 固定費を1回だけ足す理由
 *
 * `cost_settings` は**プロジェクト単位**で、それぞれが Workers Paid とドメインの
 * 月額を持っている。プロジェクトが2つあるときに全部足すと、実際には1回しか
 * 払っていない固定費が2重に乗る。ここは「実際にいくら出ていくか」を見る画面なので、
 * **設定は1行だけ読んで固定費は1回だけ**計上する。
 * プロジェクトごとの内訳が要るようになったら、あちらの /cost 画面を見るのが正しい。
 */
export async function fetchSnsCost(now: Date = new Date()): Promise<SnsCostSummary> {
  const { startMs, endMs, month } = jstMonthRange(now);
  const db = snsDb();
  if (!db) return unavailable('SNS_DB バインディングが無い', month);

  try {
    // 設定（為替レートと固定費）。プロジェクトが複数あっても1行だけ使う。
    // 行が無いのは「まだ設定していない」なので、固定費は積まない（上のコメント参照）。
    const settings = await db
      .prepare(
        `SELECT usd_jpy_rate_micro, workers_paid_micro_usd, domain_monthly_micro_usd, include_fixed_costs
         FROM cost_settings ORDER BY updated_at DESC LIMIT 1`,
      )
      .first<{
        usd_jpy_rate_micro: number;
        workers_paid_micro_usd: number;
        domain_monthly_micro_usd: number;
        include_fixed_costs: number;
      }>();

    // 従量課金・広告費。is_mock=1 はテスト用の行なので必ず外す
    // （本番DBには入らない建て付けだが、ローカルのDBを覗いたときに混ざらないように）。
    const { results } = await db
      .prepare(
        `SELECT platform,
                COALESCE(SUM(total_micro_usd), 0) AS micro,
                COALESCE(SUM(quantity), 0)        AS qty,
                COALESCE(SUM(CASE WHEN source='actual' THEN total_micro_usd ELSE 0 END), 0) AS actual
         FROM cost_events
         WHERE is_mock = 0 AND occurred_at >= ? AND occurred_at < ?
         GROUP BY platform
         ORDER BY micro DESC`,
      )
      .bind(startMs, endMs)
      .all<{ platform: string; micro: number; qty: number; actual: number }>();

    const rows = results ?? [];
    const rate = settings?.usd_jpy_rate_micro || DEFAULT_RATE_MICRO;

    const eventsMicroUsd = rows.reduce((n, r) => n + r.micro, 0);
    const actualMicroUsd = rows.reduce((n, r) => n + r.actual, 0);
    const fixedMicroUsd =
      settings && settings.include_fixed_costs
        ? settings.workers_paid_micro_usd + settings.domain_monthly_micro_usd
        : 0;
    const totalMicroUsd = eventsMicroUsd + fixedMicroUsd;

    const byPlatform: SnsCostPlatformRow[] = rows.map((r) => ({
      platform: r.platform,
      label: PLATFORM_LABELS[r.platform] ?? r.platform,
      microUsd: r.micro,
      jpy: microUsdToJpy(r.micro, rate),
      quantity: r.qty,
    }));

    if (fixedMicroUsd > 0) {
      byPlatform.push({
        platform: 'fixed',
        label: '固定費（Workers Paid＋ドメイン）',
        microUsd: fixedMicroUsd,
        jpy: microUsdToJpy(fixedMicroUsd, rate),
        quantity: 0,
      });
    }

    return {
      available: true,
      month,
      eventsMicroUsd,
      fixedMicroUsd,
      fixedConfigured: settings !== null,
      totalMicroUsd,
      totalJpy: microUsdToJpy(totalMicroUsd, rate),
      actualMicroUsd,
      byPlatform,
      usdJpyRate: rate / RATE_SCALE,
    };
  } catch (e) {
    // テーブルが無い（ローカル）／スキーマが変わった、のどちらでもここに来る。
    // ダッシュボードの他の情報まで道連れにしないよう、握って「読めなかった」を返す。
    return unavailable(e instanceof Error ? e.message : String(e), month);
  }
}
