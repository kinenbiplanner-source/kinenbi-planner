/**
 * GA4 Data API から集計を引く（/dashboard の「GA4」欄）。
 *
 * ## なぜ要るか
 *
 * 自前計測（event_daily）は**こちらが仕込んだ導線しか数えない**。
 * 「そもそも何人来たか」「どの検索語・どの参照元から入ったか」はGA4しか持っていない。
 * ダッシュボードに両方出して、**自前＝導線の成果、GA4＝母数と流入の内訳**として読み分ける。
 *
 * **2つの数字は必ずズレる**（ブロッカーでの欠損、セッションの定義、計測タイミング）。
 * 突き合わせないこと。ズレを埋めようとすると両方信用できなくなる。
 *
 * ## 認証（サービスアカウント）
 *
 * ブラウザのOAuthは使えない（cronでもサーバでも動く必要がある）ので、
 * **サービスアカウントの秘密鍵でJWTを作り、アクセストークンに交換する**。
 * ライブラリは使わず WebCrypto で署名する（Workers で `jsonwebtoken` は動かない）。
 *
 * 必要な設定（`wrangler secret put` で本番に入れる。ローカルは `.dev.vars`）：
 *
 *   GA4_PROPERTY_ID   … **数値のプロパティID**。測定ID（G-77X1XS59RB）ではない
 *   GA4_SA_EMAIL      … サービスアカウントのメール（...iam.gserviceaccount.com）
 *   GA4_SA_PRIVATE_KEY… サービスアカウントJSONの private_key（PEM。改行は \n のままでよい）
 *
 * あわせて **GA4のプロパティにそのサービスアカウントを「閲覧者」で追加**する必要がある。
 * 鍵があってもプロパティに入っていなければ 403 になる。
 *
 * ## 落ちない作り
 *
 * sns-cost.ts と同じ立場で、**このモジュールは例外を投げない**。
 * 未設定・失効・APIエラーのどれでも `available: false` を返し、画面は「—」を出す。
 * ダッシュボード全体が GA4 の都合で落ちるのを避けるため。
 */
import { env } from 'cloudflare:workers';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

/** 集計のキャッシュ。GA4 の API には日次クォータがあるので、開くたびには叩かない。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** トークンは 1 時間で失効する。少し手前で捨てる。 */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

interface Ga4Env {
  GA4_PROPERTY_ID?: string;
  GA4_SA_EMAIL?: string;
  GA4_SA_PRIVATE_KEY?: string;
}

function conf(): { propertyId: string; email: string; key: string } | null {
  const e = env as unknown as Ga4Env;
  const propertyId = (e.GA4_PROPERTY_ID ?? '').trim();
  const email = (e.GA4_SA_EMAIL ?? '').trim();
  const key = (e.GA4_SA_PRIVATE_KEY ?? '').trim();
  if (!propertyId || !email || !key) return null;
  if (!/^\d+$/.test(propertyId)) return null; // 測定ID を入れた事故を弾く
  return { propertyId, email, key };
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

/** PEM（-----BEGIN PRIVATE KEY----- …）を DER に戻す。 */
function pemToDer(pem: string): ArrayBuffer | null {
  const body = pem
    .replace(/\\n/g, '\n') // secret に \n のまま入っている場合に備える
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) return null;
  try {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  } catch {
    return null;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(c: { email: string; key: string }): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt - TOKEN_SKEW_MS) return cachedToken.value;

  const der = pemToDer(c.key);
  if (!der) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    return null;
  }

  const iat = Math.floor(now / 1000);
  const claim = {
    iss: c.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: iat + 3600,
    iat,
  };
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify(claim))}`;

  let sig: ArrayBuffer;
  try {
    sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  } catch {
    return null;
  }
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    cachedToken = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  } catch {
    return null;
  }
}

interface RunReportBody {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  limit?: number;
  orderBys?: unknown[];
}

interface ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

async function runReport(
  propertyId: string,
  token: string,
  body: RunReportBody,
): Promise<ReportRow[] | null> {
  try {
    const res = await fetch(`${API_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { rows?: ReportRow[] };
    return data.rows ?? [];
  } catch {
    return null;
  }
}

function dim(row: ReportRow, i: number): string {
  return row.dimensionValues?.[i]?.value ?? '';
}
function num(row: ReportRow, i: number): number {
  const v = Number(row.metricValues?.[i]?.value ?? '0');
  return Number.isFinite(v) ? v : 0;
}

export interface Ga4Summary {
  available: boolean;
  /** 画面に出す理由。未設定なのか、叩いて失敗したのかを区別する */
  reason?: 'not_configured' | 'auth_failed' | 'query_failed';
  days: number;
  totals: { sessions: number; users: number };
  /** 流入元 × メディア。多い順 */
  sources: Array<{ source: string; medium: string; sessions: number; users: number }>;
  /** イベント名 → 回数。キーイベントの実数 */
  events: Array<{ name: string; count: number }>;
  /** 日次のセッション。推移グラフ用（YYYY-MM-DD） */
  daily: Array<{ ymd: string; sessions: number }>;
}

const EMPTY: Omit<Ga4Summary, 'available' | 'reason' | 'days'> = {
  totals: { sessions: 0, users: 0 },
  sources: [],
  events: [],
  daily: [],
};

let cachedSummary: { at: number; days: number; value: Ga4Summary } | null = null;

/** `20260828` → `2026-08-28`。GA4 の date ディメンションは区切り無しで返る。 */
function isoFromGaDate(v: string): string {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

export async function ga4Summary(days = 28): Promise<Ga4Summary> {
  const now = Date.now();
  if (cachedSummary && cachedSummary.days === days && now - cachedSummary.at < CACHE_TTL_MS) {
    return cachedSummary.value;
  }

  const c = conf();
  if (!c) return { available: false, reason: 'not_configured', days, ...EMPTY };

  const token = await accessToken(c);
  if (!token) return { available: false, reason: 'auth_failed', days, ...EMPTY };

  const range = [{ startDate: `${days}daysAgo`, endDate: 'today' }];

  const [totalRows, sourceRows, eventRows, dailyRows] = await Promise.all([
    // 合計は**専用のクエリで引く**。ユーザー数は流入元別や日次を足すと重複するため、
    // ディメンション無しで取らないと正しい値にならない。
    runReport(c.propertyId, token, {
      dateRanges: range,
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    }),
    runReport(c.propertyId, token, {
      dateRanges: range,
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      limit: 25,
    }),
    runReport(c.propertyId, token, {
      dateRanges: range,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      limit: 50,
    }),
    runReport(c.propertyId, token, {
      dateRanges: range,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      limit: 400,
    }),
  ]);

  if (totalRows === null && sourceRows === null && eventRows === null && dailyRows === null) {
    return { available: false, reason: 'query_failed', days, ...EMPTY };
  }

  const sources = (sourceRows ?? [])
    .map((r) => ({ source: dim(r, 0) || '(none)', medium: dim(r, 1), sessions: num(r, 0), users: num(r, 1) }))
    .sort((a, b) => b.sessions - a.sessions);

  // 見たいのは導線のイベントだけ。GA4 の自動収集イベント（scroll など）は落とす。
  const WANTED = new Set([
    'form_complete',
    'form_error',
    'line_add_click',
    'cta_click',
    'links_click',
    'follow_click',
    'article_feedback',
  ]);
  const events = (eventRows ?? [])
    .map((r) => ({ name: dim(r, 0), count: num(r, 0) }))
    .filter((e) => WANTED.has(e.name))
    .sort((a, b) => b.count - a.count);

  const daily = (dailyRows ?? [])
    .map((r) => ({ ymd: isoFromGaDate(dim(r, 0)), sessions: num(r, 0) }))
    .sort((a, b) => (a.ymd < b.ymd ? -1 : 1));

  const total = (totalRows ?? [])[0];
  const value: Ga4Summary = {
    available: true,
    days,
    totals: {
      sessions: total ? num(total, 0) : sources.reduce((n, s) => n + s.sessions, 0),
      users: total ? num(total, 1) : 0,
    },
    sources,
    events,
    daily,
  };

  cachedSummary = { at: now, days, value };
  return value;
}
