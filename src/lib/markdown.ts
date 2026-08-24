/**
 * Anniv メディアの記事レンダラー。
 *
 * `.claude/agents/reference/article-style-guide.md` 9章が定める独自Markdown方言を
 * HTML に変換する。記法の一次ソースは常に style-guide 側なので、
 * 記法を足すときは必ずあちらを先に更新すること。
 *
 * markdown-it を使う理由：style-guide の `:::box color=#88c542 label="この記事の要点"` や
 * `:::timeline title=作業手順` は remark-directive の属性記法（`{key="value"}`）と形が違い、
 * remark ではそのままでは解釈できない。markdown-it-container は `:::` 直後の行が
 * まるごと token.info に渡るので、既存の記事仕様を1文字も変えずに実装できる。
 *
 * レンダリングは「保存時に1回」だけ行い、結果を D1 の body_html に入れる。
 * 管理画面のプレビューも同じ関数を通すので、プレビューと本番の見た目は必ず一致する。
 */
import MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';
import type { Token, RendererRule, Env } from 'markdown-it';

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderResult {
  html: string;
  toc: TocItem[];
  /** 本文に [[toc]] が置かれているか。サイドバー目次を出すかの判断に使う。 */
  hasToc: boolean;
  /** 未差し替えの [画像：…] プレースホルダーの数。公開前バリデーションで使う。 */
  imagePlaceholders: number;
}

/** content-axis.md が定める軸3の固定CTA。このラベルの :::box だけ CTA として描く。 */
const CTA_LABEL = '無料相談・お問い合わせ';
const CONTACT_URL = 'https://anniv.gift/contact.html';
const LINE_URL = 'https://lin.ee/U4deTzi';

const DEFAULT_BOX_COLOR = '#4a8ab5';
/** style-guide は color を HEX 指定と定めている。style 属性に入れる値なので必ず検証する。 */
const HEX = /^#[0-9a-fA-F]{6}$/;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `:::box color=#XXXXXX label="〇〇"` の属性行をほぐす。 */
function parseBoxParams(info: string): { color: string; label: string } {
  const rest = info.trim().replace(/^box\s*/, '');
  const colorMatch = rest.match(/color\s*=\s*(#[0-9a-fA-F]{3,8})/);
  const labelMatch = rest.match(/label\s*=\s*"([^"]*)"/) ?? rest.match(/label\s*=\s*'([^']*)'/);
  const rawColor = colorMatch?.[1] ?? '';
  return {
    color: HEX.test(rawColor) ? rawColor : DEFAULT_BOX_COLOR,
    label: labelMatch?.[1] ?? '',
  };
}

/** `:::timeline title=〇〇` のタイトルを取り出す。 */
function parseTimelineTitle(info: string): string {
  const m = info.trim().replace(/^timeline\s*/, '').match(/title\s*=\s*"?([^"]*)"?/);
  return (m?.[1] ?? '').trim();
}

const md = new MarkdownIt({
  // 本文中の生HTMLを無効化する。style-guide も生HTMLを許可していないので、
  // これで XSS 経路がほぼ消える（記事は自分しか書かないが、多層で守る）。
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

/* ── 単純なカスタムブロック（info / warning / danger / tip）── */
for (const name of ['info', 'warning', 'danger', 'tip'] as const) {
  md.use(container, name, {
    render: (tokens: Token[], idx: number) =>
      tokens[idx].nesting === 1 ? `<aside class="cb cb-${name}">\n` : '</aside>\n',
  });
}

/* ── :::summary（導入直後に必須の結論要約）── */
md.use(container, 'summary', {
  render: (tokens: Token[], idx: number) =>
    tokens[idx].nesting === 1
      ? '<aside class="cb cb-summary">\n<p class="cb-label">この記事のポイント</p>\n'
      : '</aside>\n',
});

/* ── :::faq ── */
md.use(container, 'faq', {
  render: (tokens: Token[], idx: number) =>
    tokens[idx].nesting === 1 ? '<div class="faq">\n' : '</div>\n',
});

/* ── :::timeline title=〇〇 ── */
md.use(container, 'timeline', {
  render: (tokens: Token[], idx: number) => {
    if (tokens[idx].nesting !== 1) return '</div>\n';
    const title = parseTimelineTitle(tokens[idx].info);
    const head = title ? `<p class="timeline-title">${esc(title)}</p>\n` : '';
    return `<div class="timeline">\n${head}`;
  },
});

/* ── :::box color=#XXXXXX label="〇〇" ── */
md.use(container, 'box', {
  render: (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    if (token.nesting === 1) {
      const { color, label } = parseBoxParams(token.info);
      // content-axis.md の軸3固定CTAは、汎用ラベルボックスとして描くと
      // ボタンとクリック計測が失われるので専用のマークアップにする。
      if (label === CTA_LABEL) {
        return (
          '<aside class="cta-box">\n' +
          `<p class="cta-label">${esc(CTA_LABEL)}</p>\n` +
          '<div class="cta-lead">\n'
        );
      }
      const labelHtml = label ? `<span class="box-label">${esc(label)}</span>\n` : '';
      return `<aside class="box" style="--box:${color}">\n${labelHtml}<div class="box-body">\n`;
    }
    // 閉じ側。直前の open トークンを探してCTAかどうか判定する。
    for (let i = idx - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.type === 'container_box_open') {
        if (parseBoxParams(t.info).label === CTA_LABEL) {
          return (
            '</div>\n<div class="cta-actions">\n' +
            `<a href="${CONTACT_URL}" class="cta-btn" data-cta="form">無料で相談する</a>\n` +
            `<a href="${LINE_URL}" class="cta-btn cta-btn-line" target="_blank" rel="noopener noreferrer" data-cta="line">LINEで相談する</a>\n` +
            '</div>\n</aside>\n'
          );
        }
        break;
      }
    }
    return '</div>\n</aside>\n';
  },
});

/* ── 蛍光マーカー：==text== / ==g:text== / ==p:text== ── */
md.inline.ruler.before('emphasis', 'anniv_marker', (state: any, silent: boolean) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) return false;
  const m = state.src.slice(start + 2).match(/^(g:|p:)?([^\n]*?)==/);
  if (!m || m[2].length === 0) return false;
  if (!silent) {
    const token = state.push('anniv_marker', '', 0);
    token.content = m[2];
    token.meta = { variant: m[1] === 'g:' ? 'g' : m[1] === 'p:' ? 'p' : '' };
  }
  state.pos = start + 2 + m[0].length;
  return true;
});

md.renderer.rules.anniv_marker = (tokens: Token[], idx: number) => {
  const token = tokens[idx];
  const variant = (token.meta?.variant as string) ?? '';
  const cls = variant ? `marker marker-${variant}` : 'marker';
  return `<mark class="${cls}">${esc(token.content)}</mark>`;
};

/* ── 画像プレースホルダー：[画像：〇〇 | alt: 〇〇] ── */
const IMG_PREFIX = '[画像：';
md.inline.ruler.before('link', 'anniv_image_ph', (state: any, silent: boolean) => {
  const start = state.pos;
  if (!state.src.startsWith(IMG_PREFIX, start)) return false;
  const end = state.src.indexOf(']', start);
  if (end === -1) return false;
  if (!silent) {
    const inner = state.src.slice(start + IMG_PREFIX.length, end);
    const [captionRaw, altRaw = ''] = inner.split('|');
    const token = state.push('anniv_image_ph', '', 0);
    token.content = captionRaw.trim();
    token.meta = { alt: altRaw.replace(/^\s*alt\s*:\s*/i, '').trim() };
    state.env.imagePlaceholders = (state.env.imagePlaceholders ?? 0) + 1;
  }
  state.pos = end + 1;
  return true;
});

md.renderer.rules.anniv_image_ph = (tokens: Token[], idx: number) => {
  const token = tokens[idx];
  const alt = (token.meta?.alt as string) ?? '';
  const altHtml = alt ? `<span class="imgph-alt">alt: ${esc(alt)}</span>` : '';
  // 段落の途中に書かれることがあるため figure ではなく span を使う（p の中に figure は置けない）。
  // 見た目のブロック化は article.css の display:block 側で行う。
  return `<span class="imgph" data-image-placeholder="1"><span class="imgph-cap">${esc(token.content)}</span>${altHtml}</span>`;
};

/* ── 目次：[[toc]] ── */
md.block.ruler.before('paragraph', 'anniv_toc', (state: any, startLine: number, _end: number, silent: boolean) => {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.slice(pos, max).trim() !== '[[toc]]') return false;
  if (silent) return true;
  state.env.hasToc = true;
  const token = state.push('anniv_toc', '', 0);
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
});

// 目次データは core ルールで env に入るので、レンダラーからそのまま組み立てられる。
// デスクトップはサイドバーに出すのでここでは描かず、モバイル用のアコーディオンだけ出す。
md.renderer.rules.anniv_toc = (_tokens: Token[], _idx: number, _opts: unknown, env: any) => {
  const toc: TocItem[] = env?.toc ?? [];
  if (!toc.length) return '';
  const items = toc
    .map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`)
    .join('\n');
  return `<details class="toc-inline"><summary>目次</summary>\n<ul>\n${items}\n</ul>\n</details>\n`;
};

/* ── 表は横スクロールできるようにラップする（比較表が幅を食うため）── */
md.renderer.rules.table_open = () => '<div class="table-wrap">\n<table>\n';
md.renderer.rules.table_close = () => '</table>\n</div>\n';

/* ── 水平線は style-guide で禁止。書かれていても描かない ── */
md.renderer.rules.hr = () => '';

/* ── 外部リンクは別タブ。内部リンク（anniv.gift）はそのまま ── */
const defaultLinkOpen: RendererRule =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet('href') ?? '');
  if (/^https?:\/\//i.test(href) && !href.includes('anniv.gift')) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/* ── 見出しのID付与・目次収集・【タグ】の抽出・FAQの整形 ── */

/** 目次に載せる用に、見出しからMarkdown記号と【タグ】を落とす。 */
function plainHeading(raw: string): string {
  return raw
    .replace(/^【[^】]+】\s*/, '')
    .replace(/==(?:[gp]:)?([^=]*)==/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/** `Q. 〇〇` / `A. 〇〇` の段落を FAQ 1問1答のマークアップに組み直す。 */
function faqItemHtml(content: string, env: Env): string {
  const parts: string[] = [];
  for (const line of content.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const q = line.match(/^Q[.．:：]\s*(.*)$/);
    const a = line.match(/^A[.．:：]\s*(.*)$/);
    if (q) {
      parts.push(`<p class="faq-q"><span class="faq-badge">Q</span>${md.renderInline(q[1], env)}</p>`);
    } else if (a) {
      parts.push(`<p class="faq-a">${md.renderInline(a[1], env)}</p>`);
    } else {
      // Q./A. が付かない行は直前の回答の続きとして扱う
      parts.push(`<p class="faq-a">${md.renderInline(line, env)}</p>`);
    }
  }
  return `<div class="faq-item">\n${parts.join('\n')}\n</div>\n`;
}

md.core.ruler.push('anniv_structure', (state: any) => {
  // renderInline から再入したときに二重処理しない
  if (state.inlineMode) return;

  const tokens: Token[] = state.tokens;
  const toc: TocItem[] = [];
  const faqRanges: Array<[number, number]> = [];
  let seq = 0;
  let timelineDepth = 0;
  let faqOpenAt = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === 'container_timeline_open') timelineDepth++;
    else if (t.type === 'container_timeline_close') timelineDepth--;
    else if (t.type === 'container_faq_open') faqOpenAt = i;
    else if (t.type === 'container_faq_close' && faqOpenAt >= 0) {
      faqRanges.push([faqOpenAt, i]);
      faqOpenAt = -1;
    }

    if (t.type !== 'heading_open') continue;
    const level = Number(t.tag.slice(1));
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;

    // timeline 内の ### は手順のステップ。番号はCSS counterで振るので目次には載せない。
    if (timelineDepth > 0) {
      t.attrJoin('class', 'timeline-step');
      continue;
    }
    if (level !== 2 && level !== 3) continue;

    // 見出し冒頭の【タグ】をチップに変換する
    const children = inline.children;
    const first = children?.[0];
    if (children && first && first.type === 'text') {
      const m = first.content.match(/^【([^】]+)】\s*/);
      if (m) {
        first.content = first.content.slice(m[0].length);
        const chip = new state.Token('html_inline', '', 0);
        chip.content = `<span class="h-tag">${esc(m[1])}</span>`;
        children.unshift(chip);
      }
    }

    // 日本語見出しをそのままIDにするとURLエンコードで崩れるので連番にする
    seq += 1;
    const id = `h-${seq}`;
    t.attrSet('id', id);
    toc.push({ id, text: plainHeading(inline.content), level: level as 2 | 3 });
  }

  // FAQ の中身を組み直す。splice で添字がずれるので後ろの範囲から処理する。
  for (const [open, close] of faqRanges.reverse()) {
    const rebuilt: Token[] = [];
    for (let i = open + 1; i < close; i++) {
      if (tokens[i].type !== 'paragraph_open') continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const htmlToken = new state.Token('html_block', '', 0);
      htmlToken.content = faqItemHtml(inline.content, state.env);
      rebuilt.push(htmlToken);
      i += 2; // paragraph_close まで飛ばす
    }
    if (rebuilt.length) tokens.splice(open + 1, close - open - 1, ...rebuilt);
  }

  state.env.toc = toc;
});

/**
 * 記事Markdownをレンダリングする。
 * 保存時に1回呼び、結果を D1 の body_html / toc_json に格納する。
 */
export function renderArticle(source: string): RenderResult {
  const env: {
    toc?: TocItem[];
    hasToc?: boolean;
    imagePlaceholders?: number;
  } = {};
  const html = md.render(source, env);
  return {
    html,
    toc: env.toc ?? [],
    hasToc: env.hasToc ?? false,
    imagePlaceholders: env.imagePlaceholders ?? 0,
  };
}
