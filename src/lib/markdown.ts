/**
 * Anniv メディアの記事レンダラー。
 *
 * `.claude/agents/reference/article-style-guide.md` 9章が定める独自Markdown方言を
 * HTML に変換する。記法の一次ソースは常に style-guide 側なので、
 * 記法を足すときは必ずあちらを先に更新すること。
 *
 * markdown-it を使う理由：style-guide の `:::box color=#1a2840 label="この記事の要点"` や
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
// 拡張子付きなのは scripts/put-draft.ts が Node から直接読むため（frontmatter.ts と同じ理由）。
// 正規化を quality.ts 側に置いてあるのは、公開前チェックが同じ解釈で本文を読む必要があるから
// （あちらはブラウザにも載るので markdown-it に依存させられない）。
import { normalizeArticleSource } from './quality.ts';

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
const CONTACT_URL = 'https://anniv.gift/contact';
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

/**
 * `:::timeline title=〇〇` / `:::details title=〇〇` のタイトルを取り出す。
 * タイトルには全角コロンや空白が入る（例：`title=補足：予算の内訳`）ので、
 * `title=` から行末までをまるごと値として扱う。
 */
function parseTitleParam(info: string, name: string): string {
  const m = info
    .trim()
    .replace(new RegExp(`^${name}\\s*`), '')
    .match(/title\s*=\s*"?([^"]*)"?/);
  return (m?.[1] ?? '').trim();
}

/**
 * `key="値"` / `key='値'` / `key=値` を1つ取り出す。
 * 引用符なしは空白までを値とする（値に空白が要るものは必ず引用符で囲ませる）。
 * 戻り値はHTMLに入れる前に必ず esc() すること。
 */
function param(info: string, key: string): string {
  const quoted =
    info.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) ??
    info.match(new RegExp(`${key}\\s*=\\s*'([^']*)'`));
  if (quoted) return quoted[1].trim();
  return (info.match(new RegExp(`${key}\\s*=\\s*(\\S+)`))?.[1] ?? '').trim();
}

/**
 * 記事から渡された href を検証する。
 * `https://` の絶対URLか、サイト内の `/` 始まりだけを通し、それ以外は既定URLに落とす。
 * これで `javascript:` や `data:`、`//evil.example` のプロトコル相対URLを弾く。
 */
function safeHref(raw: string, fallback: string): string {
  const v = raw.trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  if (/^\/(?!\/)[^\s"'<>]*$/.test(v)) return v;
  return fallback;
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
    const title = parseTitleParam(tokens[idx].info, 'timeline');
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
            `<a href="${CONTACT_URL}" class="cta-btn" data-cta="form" data-cta-label="article_body">無料で相談する</a>\n` +
            `<a href="${LINE_URL}" class="cta-btn cta-btn-line" target="_blank" rel="noopener noreferrer" data-cta="line" data-cta-label="article_body">LINEで相談する</a>\n` +
            '</div>\n</aside>\n'
          );
        }
        break;
      }
    }
    return '</div>\n</aside>\n';
  },
});

/* ── ::::columns cols=2 ＋ :::col（2〜3分割の並列レイアウト）──
   入れ子コンテナなので外側は4コロンで書く。markdown-it-container は
   「閉じマーカーは開きマーカー以上の長さが必要」という規則で入れ子を解決するため、
   外側 `::::` の中の `:::col` … `:::` が外側を閉じてしまうことがない。 */
md.use(container, 'columns', {
  render: (tokens: Token[], idx: number) => {
    if (tokens[idx].nesting !== 1) return '</div>\n';
    const raw = param(tokens[idx].info.trim().replace(/^columns\s*/, ''), 'cols');
    // 2/3以外（cols=99・未指定・文字列）はすべて2に寄せる。列数はクラス名で表現し、
    // style属性に値を差し込まないので記事側から不正な値が漏れることはない。
    const cols = raw === '3' ? 3 : 2;
    return `<div class="cols cols-${cols}">\n`;
  },
});
md.use(container, 'col', {
  render: (tokens: Token[], idx: number) =>
    tokens[idx].nesting === 1 ? '<div class="col">\n' : '</div>\n',
});

/* ── :::banner theme=navy label="〇〇" href="https://…"（記事中の送客バナー）── */
const BANNER_THEMES = new Set(['navy', 'gold', 'line']);
const BANNER_DEFAULT_LABEL = '無料で相談する';
/** LINE公式アカウントのURLかどうか。計測イベントの種類（line / form）をこれで決める。 */
const LINE_HREF = /^https:\/\/lin\.ee\//i;

function parseBannerParams(info: string): { theme: string; label: string; href: string } {
  const rest = info.trim().replace(/^banner\s*/, '');
  const themeRaw = param(rest, 'theme');
  const theme = BANNER_THEMES.has(themeRaw) ? themeRaw : 'navy';
  return {
    theme,
    label: param(rest, 'label') || BANNER_DEFAULT_LABEL,
    // theme=line のときだけ既定URLをLINEにする。緑のLINEバナーが問い合わせフォームに
    // 飛ぶと見た目と遷移先が食い違うため（href を明示すればそちらが優先される）。
    href: safeHref(param(rest, 'href'), theme === 'line' ? LINE_URL : CONTACT_URL),
  };
}

md.use(container, 'banner', {
  render: (tokens: Token[], idx: number) => {
    if (tokens[idx].nesting !== 1) {
      return '</div>\n</div>\n<span class="cta-banner-arrow" aria-hidden="true">→</span>\n</a>\n';
    }
    const { theme, label, href } = parseBannerParams(tokens[idx].info);
    // 計測設計.md 3章：MediaLayout.astro の委譲リスナーが data-cta / data-cta-label を見て発火する。
    // 種類は theme（見た目）ではなく遷移先で決める。
    const kind = LINE_HREF.test(href) ? 'line' : 'form';
    const external = /^https:\/\//i.test(href) && !href.includes('anniv.gift');
    const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return (
      `<a class="cta-banner cta-banner-${theme}" href="${esc(href)}"${target}` +
      ` data-cta="${kind}" data-cta-label="article_banner">\n` +
      '<div class="cta-banner-main">\n' +
      `<span class="cta-banner-label">${esc(label)}</span>\n` +
      // 補足行は省略できる。改行を入れずに閉じると空要素のままになり、
      // CSS 側の `.cta-banner-note:empty` で余白ごと畳める。
      '<div class="cta-banner-note">'
    );
  },
});

/* ── :::hero image=… label=… title=… btn=… href=…（本文中のビジュアルCTA）──
   :::banner が文字だけの細い導線なのに対し、こちらは写真を敷いた面で見せる強い導線。
   文字は画像に焼き込まずHTMLで出す：モバイルで潰れない・コピーだけ後から差し替えられる・
   リンク文言がそのまま検索と計測に乗る。写真は装飾なので alt="" にする（リンク名は文字側が持つ）。
   1記事に1本まで（style-guide 9章）。 */
const HERO_IMAGE = '/assets/cta-hero.webp';
const HERO_LABEL = '無料相談・お問い合わせ';
const HERO_TITLE = '記念日の準備、まずは相談してみる';
const HERO_BTN = '無料で相談する';

function parseHeroParams(info: string): {
  image: string;
  label: string;
  title: string;
  btn: string;
  href: string;
} {
  const rest = info.trim().replace(/^hero\s*/, '');
  return {
    // 画像も href と同じ検証に通す（`javascript:` や別ドメインの読み込みを防ぐ）
    image: safeHref(param(rest, 'image'), HERO_IMAGE),
    label: param(rest, 'label') || HERO_LABEL,
    title: param(rest, 'title') || HERO_TITLE,
    btn: param(rest, 'btn') || HERO_BTN,
    href: safeHref(param(rest, 'href'), CONTACT_URL),
  };
}

md.use(container, 'hero', {
  render: (tokens: Token[], idx: number) => {
    if (tokens[idx].nesting !== 1) {
      // ボタン文言は開きマーカーの属性にあるので、閉じるときに遡って拾う（:::box のCTAと同じ手）。
      let btn = HERO_BTN;
      for (let i = idx - 1; i >= 0; i--) {
        if (tokens[i].type === 'container_hero_open') {
          btn = parseHeroParams(tokens[i].info).btn;
          break;
        }
      }
      return (
        '</div>\n' +
        `<span class="cta-hero-btn">${esc(btn)}` +
        '<span class="cta-hero-arrow" aria-hidden="true">→</span></span>\n' +
        '</div>\n</a>\n'
      );
    }
    const { image, label, title, href } = parseHeroParams(tokens[idx].info);
    // 計測設計.md 3章：種類は見た目ではなく遷移先で決める（event_label は article_hero）。
    const kind = LINE_HREF.test(href) ? 'line' : 'form';
    const external = /^https:\/\//i.test(href) && !href.includes('anniv.gift');
    const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return (
      `<a class="cta-hero" href="${esc(href)}"${target}` +
      ' data-cta="' +
      kind +
      '" data-cta-label="article_hero">\n' +
      `<img class="cta-hero-bg" src="${esc(image)}" alt="" width="1200" height="400"` +
      ' loading="lazy" decoding="async">\n' +
      '<div class="cta-hero-inner">\n' +
      `<span class="cta-hero-eyebrow">${esc(label)}</span>\n` +
      `<span class="cta-hero-title">${esc(title)}</span>\n` +
      // 補足行は省略できる。空のまま閉じても .cta-hero-note:empty で畳まれる。
      '<div class="cta-hero-note">'
    );
  },
});

/* ── :::details title=〇〇（長い補足を畳む）──
   :::faq が一問一答の見せ方なのに対し、こちらは本文の流れを止めたくない
   長い補足（内訳・前提条件・細かい注意）を初期状態で閉じておくためのもの。 */
md.use(container, 'details', {
  render: (tokens: Token[], idx: number) => {
    if (tokens[idx].nesting !== 1) return '</div>\n</details>\n';
    const title = parseTitleParam(tokens[idx].info, 'details') || '詳しく見る';
    return `<details class="fold">\n<summary class="fold-head">${esc(title)}</summary>\n<div class="fold-body">\n`;
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
  let detailsDepth = 0;
  let faqOpenAt = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === 'container_timeline_open') timelineDepth++;
    else if (t.type === 'container_timeline_close') timelineDepth--;
    else if (t.type === 'container_details_open') detailsDepth++;
    else if (t.type === 'container_details_close') detailsDepth--;
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
    // :::details の中は閉じた状態で描かれるので、目次に載せるとジャンプ先が
    // 見えない見出しになる。IDも振らずそのまま見出しとして描くだけにする。
    if (detailsDepth > 0) continue;
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
  const html = md.render(normalizeArticleSource(source), env);
  return {
    html,
    toc: env.toc ?? [],
    hasToc: env.hasToc ?? false,
    imagePlaceholders: env.imagePlaceholders ?? 0,
  };
}
