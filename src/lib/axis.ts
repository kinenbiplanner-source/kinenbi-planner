/**
 * コンテンツ軸の定義。
 *
 * 表示名は `.claude/agents/reference/content-axis.md` の「軸一覧」の正式名称に揃える。
 * DB には短いスラッグを保存し、URL（/media/category/<slug>）もこれを使う。
 * 記事本体の URL は /media/<slug> のフラット構成にしてあるので、
 * 記事の軸を後から変えても記事 URL は壊れない。
 */

export const AXES = [
  {
    slug: 'gift',
    name: '記念日ギフト・サプライズ',
    short: 'ギフト',
    description: 'プレゼントの選び方と、サプライズ演出のアイデア・進め方。',
  },
  {
    slug: 'date',
    name: '記念日デート・レストラン',
    short: 'デート',
    description: '記念日ディナーの店選びと、予約から当日までの段取り。',
  },
  {
    slug: 'concierge',
    name: '記念日代行・サプライズ代行サービス',
    short: '代行',
    description: '記念日の準備をまるごと任せたい人向けの、代行サービスの選び方。',
  },
] as const;

export type AxisSlug = (typeof AXES)[number]['slug'];

/** ファネル層。content-axis.md の3層（受け皿＝フォームはCV着地点なので含めない）。 */
export const FUNNELS = ['集客', '比較・検討', '課題解決'] as const;
export type Funnel = (typeof FUNNELS)[number];

const BY_SLUG = new Map(AXES.map((a) => [a.slug, a]));

export function getAxis(slug: string) {
  return BY_SLUG.get(slug as AxisSlug);
}

/** 表示名（未知の値が入っていてもスラッグをそのまま返して落とさない）。 */
export function axisName(slug: string): string {
  return BY_SLUG.get(slug as AxisSlug)?.name ?? slug;
}

export function axisShort(slug: string): string {
  return BY_SLUG.get(slug as AxisSlug)?.short ?? slug;
}

export function isAxisSlug(v: string): v is AxisSlug {
  return BY_SLUG.has(v as AxisSlug);
}

export function isFunnel(v: string): v is Funnel {
  return (FUNNELS as readonly string[]).includes(v);
}

/**
 * write-article の frontmatter に入りうる軸の表記をスラッグへ寄せる。
 * 正式名のほか、content.config.ts で使っていた短縮名やスラッグ直書きも受ける。
 */
export function normalizeAxis(input: string): AxisSlug | null {
  const v = input.trim();
  if (isAxisSlug(v)) return v;
  for (const a of AXES) {
    if (v === a.name || v === a.short) return a.slug;
  }
  // 「ギフト・サプライズ」「デート・レストラン」「代行サービス」など、
  // 正式名の一部だけが書かれているケースを拾う。
  for (const a of AXES) {
    if (a.name.includes(v) || v.includes(a.short)) return a.slug;
  }
  return null;
}
