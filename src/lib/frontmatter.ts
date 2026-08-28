/**
 * anniv-write-article（`.claude/skills/anniv-write-article/SKILL.md` Step 6-4）が出力する
 * `article.md` の frontmatter をほぐす。
 *
 * 管理画面（記事エディタ）で本文に貼られた article.md の frontmatter を、これで剥がす。
 * ここが記事制作フローと公開システムの接続点なので、キー名は SKILL.md 側に合わせる：
 *   title / description / keyword / axis / funnel / published（＋アフィリ記事のみ ad: true）
 *
 * 依存を増やしたくないので YAML パーサは使わず、フラットな `key: value` だけを読む。
 * 記事の frontmatter にネストは出てこない。
 */
// 拡張子を付けているのはこの行だけ。scripts/put-draft.ts が Node から
// このファイルを直接読む（＝Viteを通さない）ので、拡張子が無いと解決できない。
import { normalizeAxis, isFunnel, type AxisSlug, type Funnel } from './axis.ts';

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

/**
 * slug を決めずに下書きを保存したとき（＝一時保存）に割り当てる仮の値。
 *
 * articles.slug は NOT NULL UNIQUE で、公開URLそのものでもある。
 * 「まだ決めていない」を素直に表すなら NULL 許容にするところだが、
 * スキーマを緩めると公開記事の slug まで空を許すことになるので、
 * 代わりに「見れば仮だと分かる値」を入れておき、公開時に本物を必ず要求する。
 *
 * 形は isValidSlug を通る範囲で作る（他の処理に例外を持ち込まないため）。
 * 下書きは /media/ で配信されないので、この値がURLとして使われることはない。
 */
export function makePlaceholderSlug(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `draft-x${stamp}${rand}`;
}

/** 仮の slug か（＝ユーザーがまだ決めていない）。画面では未設定として扱う。 */
export function isPlaceholderSlug(slug: string): boolean {
  return /^draft-x[a-z0-9]{6,}$/.test(slug);
}
