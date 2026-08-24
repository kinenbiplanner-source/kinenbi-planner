/**
 * write-article（`.claude/skills/write-article/SKILL.md` Step 6-4）が出力する
 * `article.md` の frontmatter をほぐす。
 *
 * 管理画面の「article.md を貼り付けて取り込む」がこれを使う。
 * ここが記事制作フローと公開システムの接続点なので、キー名は SKILL.md 側に合わせる：
 *   title / description / keyword / axis / funnel / published（＋アフィリ記事のみ ad: true）
 *
 * 依存を増やしたくないので YAML パーサは使わず、フラットな `key: value` だけを読む。
 * 記事の frontmatter にネストは出てこない。
 */
import { normalizeAxis, isFunnel, type AxisSlug, type Funnel } from './axis';

export interface ParsedArticle {
  title: string;
  description: string;
  keyword: string;
  /** 解決できなかった場合は null。管理画面側で選ばせる。 */
  axis: AxisSlug | null;
  funnel: Funnel | null;
  /** YYYY-MM-DD。無ければ null。 */
  published: string | null;
  isAd: boolean;
  body: string;
  /** frontmatter が無い（本文だけ貼られた）場合 true。 */
  bodyOnly: boolean;
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** `axis: A | B | C` のようにSKILL.mdの選択肢がそのまま残っている場合を弾く。 */
function firstChoice(v: string): string {
  return v.split('|')[0].trim();
}

/** 行末の `# コメント` を落とす（SKILL.mdの雛形にコメント付きの行がある）。 */
function stripComment(v: string): string {
  return v.replace(/\s+#.*$/, '');
}

export function parseArticle(source: string): ParsedArticle {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);

  if (!m) {
    return {
      title: '',
      description: '',
      keyword: '',
      axis: null,
      funnel: null,
      published: null,
      isAd: false,
      body: text.trim(),
      bodyOnly: true,
    };
  }

  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    fields.set(line.slice(0, sep).trim(), stripComment(unquote(line.slice(sep + 1))));
  }

  const rawAxis = firstChoice(fields.get('axis') ?? '');
  const rawFunnel = firstChoice(fields.get('funnel') ?? '');
  const rawPublished = fields.get('published') ?? '';
  const adValue = (fields.get('ad') ?? '').toLowerCase();

  return {
    title: fields.get('title') ?? '',
    description: fields.get('description') ?? '',
    keyword: fields.get('keyword') ?? '',
    axis: rawAxis ? normalizeAxis(rawAxis) : null,
    funnel: isFunnel(rawFunnel) ? rawFunnel : null,
    published: /^\d{4}-\d{2}-\d{2}$/.test(rawPublished) ? rawPublished : null,
    isAd: adValue === 'true' || adValue === 'yes',
    body: text.slice(m[0].length).trim(),
    bodyOnly: false,
  };
}

/** slug は人が確定させる値（style-guide 11章）。形式だけ検証する。 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;
}
