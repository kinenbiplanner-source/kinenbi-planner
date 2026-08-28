/**
 * 記事の品質チェック。
 *
 * article-style-guide.md のうち「機械で判定できる項目」だけを写している。
 * 判定の根拠は各チェックのコメントに章番号で残す（ルールの正は style-guide 側。
 * あちらを変えたらここも直す）。
 *
 * サーバ（/api/articles の公開時 warnings）とクライアント（エディタの
 * チェックパネル）の両方から呼ぶ。これは意図的で、「エディタでは何も出ないのに
 * 公開したら警告が出る」という食い違いを構造的に無くすため。
 * その制約から、このファイルは import を持たない純粋関数だけで書く
 * （D1にもR2にも触らない。ブラウザにそのままバンドルされる）。
 */

export type CheckLevel = 'ng' | 'warn' | 'ok';

export interface CheckItem {
  id: string;
  /** 何を見ているか。パネルの左に出る短いラベル */
  label: string;
  level: CheckLevel;
  /** 結果。ok のときも数値を出す（「32字以内」より「28字 / 32字以内」の方が次の判断ができる） */
  detail: string;
  /** 該当箇所の行（0始まり）。エディタからその行へ飛ぶために使う */
  line?: number;
}

export interface Heading {
  level: 2 | 3;
  text: string;
  /** 本文の何行目か（0始まり） */
  line: number;
  /** 本文先頭からの文字位置（textarea のキャレット移動に使う） */
  pos: number;
}

export interface InspectInput {
  title: string;
  description: string;
  keyword: string;
  body_md: string;
  /** 軸。concierge だけ自己言及の扱いが変わる（style-guide 2章の例外） */
  axis: string;
  /**
   * 既存記事の slug → 状態。内部リンクの飛び先が実在するかを見る。
   * 渡さなければ実在チェックはしない（本数だけ数える）。
   */
  slugStatus?: Record<string, 'published' | 'draft'>;
}

/** 日本語は1文字＝1コードポイントで数える。 */
export function charCount(s: string): number {
  return [...s].length;
}

/** description の目安（style-guide 17章）。API 側の警告レンジもこれを使う。 */
export const DESC_MIN = 60;
export const DESC_MAX = 140;

/* ────────────────────────────────────────────────
 * 本文の走査
 * ──────────────────────────────────────────────── */

/** コードブロックの開始・終了行。 */
const FENCE_RE = /^\s*(```|~~~)/;
/** カスタムブロック（:::name / ::::columns …）の開始と、名前なしの閉じ。 */
const CONTAINER_RE = /^(:{3,})\s*([a-zA-Z][\w-]*)?/;
/**
 * 本文の末尾に閉じの `:::` が書かれている行（`… 決める :::`）。
 * markdown-it-container は行頭のフェンスしか閉じと見なさないので、この形は
 * 「閉じたつもりが閉じていない」＝以降の記事が丸ごとブロックの中に入る事故になる。
 * 書き手の意図は明らかなので、正規化で単独行へ割る（下の normalizeArticleSource）。
 */
const FENCE_TAIL_RE = /^(.*?[^\s:])\s*(:{3,})\s*$/;
/** 既に箇条書き・見出し・引用・表・画像になっている行（要点の自動箇条書きから外す）。 */
const NOT_PLAIN_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||!\[|\[)/;

/**
 * レンダリング前の正規化。
 *
 * 記事は人とエージェントが書くので、「意図は明らかだが markdown-it が
 * そのままでは解釈できない」形が混ざる。表示を壊したまま公開するより、
 * ここで直してから流す方が実害が小さい（記法の正は style-guide 側のまま）。
 *
 *   1. 本文の末尾に書かれた閉じの `:::` を単独行に割る
 *      —— 閉じ損なうと以降の記事が全部そのブロックの中に入ってしまう
 *   2. `:::summary` の中の素の行を箇条書きにする
 *      —— style-guide 4-3 が「箇条書きのみ」と決めており、素の行が続くと
 *         markdown が1つの段落に畳んで要点が読めなくなる
 *
 * 保存する body_md は書き手が打ったまま。ここで変えるのは出力だけ。
 */
export function normalizeArticleSource(source: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inFence = false;

  for (const line of source.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const c = line.match(CONTAINER_RE);
    if (c) {
      if (c[2]) stack.push(c[2]);
      else stack.pop();
      out.push(line);
      continue;
    }

    const inSummary = stack[stack.length - 1] === 'summary';

    // 1. 本文と同じ行に書かれた閉じフェンス（開いているときだけ閉じと解釈する）
    const tail = stack.length ? line.match(FENCE_TAIL_RE) : null;
    if (tail) {
      const body = tail[1];
      out.push(inSummary && body.trim() && !NOT_PLAIN_LINE_RE.test(body) ? `- ${body.trim()}` : body);
      out.push(tail[2]);
      stack.pop();
      continue;
    }

    // 2. 要点の素の行
    if (inSummary && line.trim() && !NOT_PLAIN_LINE_RE.test(line)) {
      out.push(`- ${line.trim()}`);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * 閉じられていないカスタムブロック。
 * 閉じ忘れると以降の本文が丸ごとブロックの中に入るが、HTMLとしては壊れないので
 * プレビューを流し読みすると気付けない。公開前チェックで拾うために返す。
 */
export function unclosedContainer(body: string): { name: string; line: number } | null {
  const open: Array<{ name: string; line: number }> = [];
  const lines = body.split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const c = line.match(CONTAINER_RE);
    if (c) {
      if (c[2]) open.push({ name: c[2], line: i });
      else open.pop();
      continue;
    }
    // 本文の末尾に書かれた ::: も閉じとして数える（正規化がそう解釈するため）
    if (open.length && FENCE_TAIL_RE.test(line)) open.pop();
  }
  return open[open.length - 1] ?? null;
}

/**
 * H2/H3 を拾う。
 *
 * markdown.ts の anniv_structure と同じ条件に揃える：
 *   - コードブロックの中は見ない
 *   - :::timeline の中の ### は手順のステップなので見出しではない
 *   - :::details の中の見出しは目次に載らない（閉じているので飛べない）
 */
export function scanHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  const lines = body.split('\n');
  const stack: string[] = [];
  let inFence = false;
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineStart = pos;
    pos += line.length + 1;

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 行末に書かれた閉じフェンスは、正規化と同じく「閉じ」として扱う。
    // ここで数え損なうと、以降の見出しがブロックの中と判定されて目次から消える。
    // 行そのものは残す（行番号がズレるとエディタのジャンプ先が狂う）。
    if (stack.length && FENCE_TAIL_RE.test(line)) {
      line = line.replace(/\s*:{3,}\s*$/, '');
      stack.pop();
    }

    const c = line.match(CONTAINER_RE);
    if (c) {
      if (c[2]) stack.push(c[2]);
      else stack.pop();
      continue;
    }

    const h = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!h) continue;
    if (stack.includes('timeline') || stack.includes('details')) continue;

    out.push({
      level: h[1].length as 2 | 3,
      // 見出し冒頭の【タグ】は表示側でチップになるので字数から外す
      text: h[2].replace(/^【[^】]*】\s*/, '').trim(),
      line: i,
      pos: lineStart,
    });
  }
  return out;
}

/**
 * 「純文」＝読み物としての文字列。style-guide 16章の字数はこれで数える。
 * Markdown記号・URL・表の罫線・コードブロック・ブロック記法の行を落とす。
 */
export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/^:{3,}.*$/gm, '')
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, '')
    .replace(/\[\[toc\]\]/g, '')
    .replace(/\[画像：[^\]]*\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/==[gp]:/g, '')
    .replace(/==/g, '')
    .replace(/`/g, '')
    .replace(/\|/g, '')
    .replace(/^\s*-{3,}\s*$/gm, '');
}

/** 純文の字数。空白・改行は数えない（日本語の記事量はこれで数えた方が実感に合う）。 */
export function plainLength(body: string): number {
  return charCount(plainText(body).replace(/\s+/g, ''));
}

/** メインKWを語に割る（「記念日 プレゼント 30代」→ 3語）。 */
export function keywordTokens(keyword: string): string[] {
  return keyword
    .split(/[\s　]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function hasToken(haystack: string, token: string): boolean {
  return haystack.toLowerCase().includes(token.toLowerCase());
}

/* ────────────────────────────────────────────────
 * 個別ルールの材料
 * ──────────────────────────────────────────────── */

/**
 * 自己言及・看板ワード（style-guide 2章）。部分一致で禁止。
 * 軸3（concierge）は解禁されているので、そちらでは「乱用していないか」の確認に落とす。
 */
const SELF_WORDS = [
  '代行会社',
  '弊社',
  '当社',
  '自社',
  '我々',
  '私たち',
  'うちのチーム',
  '運営側',
  '中の人',
  'プロの目線',
  '現場の視点',
];

/** 「〜の視点で」「〜の目線で」「〜の立場で」型の枕詞。 */
const SELF_SUFFIX_RE = /[^\s。、「」]{1,10}(?:の)?(?:視点|目線|立場)で/;

/** URLを落とす。anniv.gift のリンクに含まれる社名を自己言及と誤判定しないため。 */
function withoutUrls(body: string): string {
  return body.replace(/\]\([^)]*\)/g, ']()').replace(/https?:\/\/\S+/g, '');
}

/** 内部リンク（/media/<slug>）を拾う。絶対URLで書かれていても拾う。 */
function internalLinks(body: string): Array<{ slug: string; line: number }> {
  const out: Array<{ slug: string; line: number }> = [];
  const lines = body.split('\n');
  const re = /\]\((?:https?:\/\/anniv\.gift)?\/media\/([a-z0-9-]+)\/?\)/g;
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) out.push({ slug: m[1], line: i });
  }
  return out;
}

/**
 * 先頭に frontmatter（`---` で囲まれた設定ブロック）が残っているか。
 * 記事の実体は D1 で、メタ情報は列として持つ。本文に残したまま保存すると
 * 設定がそのまま記事の先頭に印字される。
 */
export function leadingFrontmatterLines(body: string): number {
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/);
  return m ? m[0].replace(/\r?\n$/, '').split('\n').length : 0;
}

/** マーカー記号だけ残した本文（マーカーの数を数えるためのもの）。 */
function keepMarkers(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/^:{3,}.*$/gm, '');
}

/* ────────────────────────────────────────────────
 * 本体
 * ──────────────────────────────────────────────── */

/**
 * 記事を見て、チェック結果の一覧を返す。
 * 並び順はそのままパネルの並びになるので、「上から順に直せば公開できる」順に置く
 * （メタ情報 → 骨格 → 本文の中身）。
 */
export function inspectArticle(input: InspectInput): CheckItem[] {
  const { title, description, keyword, body_md: body, axis } = input;
  const items: CheckItem[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string, line?: number) => {
    items.push({ id, label, level, detail, line });
  };

  const tokens = keywordTokens(keyword);
  const headings = scanHeadings(body);
  const h2 = headings.filter((h) => h.level === 2);
  const lines = body.split('\n');
  const clean = withoutUrls(body);

  /* ── タイトル（6章：32字以内・メインKWを自然文に含める）── */
  const titleLen = charCount(title);
  if (!title) {
    add('title', 'タイトル', 'warn', '未入力');
  } else {
    add('title', 'タイトル', titleLen <= 32 ? 'ok' : 'ng', `${titleLen}字 / 32字以内`);
    if (tokens.length) {
      const missing = tokens.filter((t) => !hasToken(title, t));
      add(
        'title-kw',
        'タイトルのKW',
        missing.length === 0 ? 'ok' : 'warn',
        missing.length === 0 ? 'メインKWを含む' : `「${missing.join('・')}」が入っていない`,
      );
    }
  }

  /* ── ディスクリプション（17章：120字前後・冒頭60字にKW）── */
  const descLen = charCount(description);
  if (!description) {
    add('desc', 'ディスクリプション', 'warn', '未入力');
  } else {
    const ok = descLen >= DESC_MIN && descLen <= DESC_MAX;
    add('desc', 'ディスクリプション', ok ? 'ok' : 'warn', `${descLen}字 / ${DESC_MIN}〜${DESC_MAX}字`);
    if (tokens.length) {
      const head = [...description].slice(0, 60).join('');
      const missing = tokens.filter((t) => !hasToken(head, t));
      add(
        'desc-kw',
        'ディスクリプションのKW',
        missing.length === 0 ? 'ok' : 'warn',
        missing.length === 0 ? '冒頭60字にメインKWがある' : `冒頭60字に「${missing.join('・')}」が無い`,
      );
    }
  }

  /* ── frontmatter の消し残し ──
     普段は無いのが当たり前なので、残っているときだけ行を出す（○の行は増やさない）。 */
  const fmLines = leadingFrontmatterLines(body);
  if (fmLines) {
    add('frontmatter', 'frontmatter', 'ng', '本文の先頭に残っている（メタ情報に取り込むこと）', 0);
  }

  /* ── リード（4章：冒頭100字にメインKW／:::summary 必須）── */
  const leadRaw = h2.length ? body.slice(0, h2[0].pos) : body;
  const lead = plainText(leadRaw).replace(/\s+/g, '');
  if (tokens.length) {
    const head = [...lead].slice(0, 100).join('');
    const missing = tokens.filter((t) => !hasToken(head, t));
    add(
      'lead-kw',
      'リードのKW',
      !lead ? 'warn' : missing.length === 0 ? 'ok' : 'warn',
      !lead
        ? 'リード文が無い'
        : missing.length === 0
          ? '冒頭100字にメインKWがある'
          : `冒頭100字に「${missing.join('・')}」が無い`,
    );
  }
  const hasSummary = /^:{3,}\s*summary\b/m.test(leadRaw);
  add(
    'lead-summary',
    'リードの要点',
    hasSummary ? 'ok' : 'warn',
    hasSummary ? ':::summary がある' : 'リードに :::summary が無い（4章で必須）',
  );

  /* ── ブロックの閉じ忘れ ──
     閉じ忘れても HTML は壊れないが、以降の本文が丸ごとブロックの中に入る。
     プレビューを流し読みすると気付けないので、残っているときだけ行を出す。 */
  const unclosed = unclosedContainer(body);
  if (unclosed) {
    add(
      'container',
      'ブロックの閉じ',
      'ng',
      `:::${unclosed.name} が閉じられていない（以降の本文が中に入る）`,
      unclosed.line,
    );
  }

  /* ── 目次（9章：記法は [[toc]] のみ）── */
  const hasToc = /\[\[toc\]\]/.test(body);
  add('toc', '目次', hasToc ? 'ok' : 'warn', hasToc ? '[[toc]] がある' : '[[toc]] が無い');

  /* ── まとめH2（5章：最後に結論を含むまとめH2を必ず置く）── */
  if (h2.length === 0) {
    add('matome', 'まとめH2', 'ng', 'H2見出しが1つも無い');
  } else {
    const last = h2[h2.length - 1];
    const isMatome = /まとめ|結論/.test(last.text);
    const bare = /^まとめ$/.test(last.text);
    add(
      'matome',
      'まとめH2',
      isMatome && !bare ? 'ok' : 'ng',
      bare
        ? '見出しが「まとめ」単体（結論を含める）'
        : isMatome
          ? `最後のH2「${last.text}」`
          : `最後のH2が「${last.text}」でまとめになっていない`,
      last.line,
    );
  }

  /* ── 見出しの長さ（7章：25〜30字以内）── */
  const longHeads = headings.filter((h) => charCount(h.text) > 30);
  add(
    'heading-len',
    '見出しの長さ',
    longHeads.length === 0 ? 'ok' : 'warn',
    longHeads.length === 0
      ? `H2 ${h2.length}本 / H3 ${headings.length - h2.length}本、すべて30字以内`
      : `30字超が${longHeads.length}本（例：${longHeads[0].text}）`,
    longHeads[0]?.line,
  );

  /* ── 見出し直後のブロック直置き（3章：間に1〜3文挟む）── */
  const stuck = headings.filter((h) => {
    for (let i = h.line + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      return /^:{3,}\s*[a-zA-Z]/.test(l);
    }
    return false;
  });
  add(
    'heading-block',
    '見出し直後',
    stuck.length === 0 ? 'ok' : 'warn',
    stuck.length === 0
      ? 'ブロック直置きなし'
      : `${stuck.length}本の見出しの直後がブロック（例：${stuck[0].text}）`,
    stuck[0]?.line,
  );

  /* ── 本文量（16章：純文6000字目安。3000未満は加筆、10000超は削減）── */
  const len = plainLength(body);
  add(
    'length',
    '本文量',
    len === 0 || len < 3000 || len > 10000 ? 'warn' : 'ok',
    len === 0
      ? '本文が空'
      : len < 3000
        ? `純文 ${len}字（3000字未満：網羅性不足を疑う）`
        : len > 10000
          ? `純文 ${len}字（10000字超：冗長を疑う）`
          : `純文 ${len}字 / 6000字目安`,
  );

  /* ── 画像プレースホルダーの残り（公開前に差し替える）── */
  const phCount = (body.match(/\[画像：/g) ?? []).length;
  const phLine = lines.findIndex((l) => l.includes('[画像：'));
  add(
    'image-ph',
    '画像プレースホルダー',
    phCount === 0 ? 'ok' : 'warn',
    phCount === 0 ? '残っていない' : `未差し替えが${phCount}件`,
    phLine >= 0 ? phLine : undefined,
  );

  /* ── ローカル画像パスの残り（9章「要約カード」。R2へ上げないと公開先で壊れる）──
     要約カードは `記事/[KW名]/images/*.png` として手元で作るので、本文には
     `![alt](images/card_01_x.png)` の形で入ったまま貼られやすい。相対パスは
     /media/<slug> 配下から解決されるので404になる。絶対パス(/media/img/...)か
     外部URLになっていない画像参照を拾う。 */
  const localImgRe = /!\[[^\]]*\]\((?!https?:|\/|data:)[^)]+\)/g;
  const localImgCount = (body.match(localImgRe) ?? []).length;
  const localImgLine = lines.findIndex((l) => new RegExp(localImgRe.source).test(l));
  add(
    'image-local',
    'ローカル画像パス',
    localImgCount === 0 ? 'ok' : 'ng',
    localImgCount === 0
      ? '残っていない'
      : `${localImgCount}件（管理画面でアップロードして /media/img/… に差し替える）`,
    localImgLine >= 0 ? localImgLine : undefined,
  );

  /* ── 自己言及・看板ワード（2章。軸3だけ解禁）── */
  const hitWord = SELF_WORDS.find((w) => clean.includes(w));
  const hitSuffix = hitWord ? null : clean.match(SELF_SUFFIX_RE);
  const hit = hitWord ?? hitSuffix?.[0] ?? null;
  const selfLine = hit ? lines.findIndex((l) => withoutUrls(l).includes(hit)) : -1;
  if (axis === 'concierge') {
    // 軸3は立場表明が解禁されている。ただし「要所だけ」なので件数だけ見る
    const count = SELF_WORDS.reduce((n, w) => n + (clean.split(w).length - 1), 0);
    add(
      'self-ref',
      '自己言及',
      count > 3 ? 'warn' : 'ok',
      count === 0 ? 'なし' : `${count}件（軸3は解禁。要所だけに留める）`,
      selfLine >= 0 ? selfLine : undefined,
    );
  } else {
    add(
      'self-ref',
      '自己言及',
      hit ? 'ng' : 'ok',
      hit ? `「${hit}」がある（軸1・軸2ではMust Fix）` : 'なし',
      selfLine >= 0 ? selfLine : undefined,
    );
  }

  /* ── 水平線（9章：--- は使わない）──
     frontmatter の `---` を水平線として二重に数えない（上の行で別途出している）。 */
  const hrLine = lines.findIndex((l, i) => i >= fmLines && /^\s*-{3,}\s*$/.test(l));
  add(
    'hr',
    '水平線',
    hrLine < 0 ? 'ok' : 'warn',
    hrLine < 0 ? '使っていない' : '--- がある（区切りは見出しとブロックで作る）',
    hrLine >= 0 ? hrLine : undefined,
  );

  /* ── 内部リンク（11章：URLを推測・生成しない＝実在するものだけ）── */
  const links = internalLinks(body);
  if (input.slugStatus) {
    const map = input.slugStatus;
    const dead = links.filter((l) => !(l.slug in map));
    const draft = links.filter((l) => map[l.slug] === 'draft');
    add(
      'internal-link',
      '内部リンク',
      dead.length ? 'ng' : draft.length ? 'warn' : 'ok',
      dead.length
        ? `存在しないslugへのリンク：/media/${dead[0].slug}`
        : draft.length
          ? `下書き記事へのリンク：/media/${draft[0].slug}`
          : `${links.length}本`,
      (dead[0] ?? draft[0])?.line,
    );
  } else {
    add('internal-link', '内部リンク', 'ok', `${links.length}本`);
  }

  /* ── マーカーの乱用（9章：H2ごとに1箇所まで）── */
  const sections = h2.length
    ? h2.map((h, i) => body.slice(h.pos, i + 1 < h2.length ? h2[i + 1].pos : body.length))
    : [body];
  let over = 0;
  let overAt: number | undefined;
  for (let i = 0; i < sections.length; i++) {
    const n = (keepMarkers(sections[i]).match(/==(?:[gp]:)?[^=]+==/g) ?? []).length;
    if (n >= 2) {
      over++;
      if (overAt === undefined) overAt = h2[i]?.line;
    }
  }
  add(
    'marker',
    'マーカー',
    over === 0 ? 'ok' : 'warn',
    over === 0 ? 'H2ごとに1箇所まで' : `${over}セクションで2箇所以上`,
    overAt,
  );

  return items;
}

/**
 * 公開時に画面へ出す警告文へ落とす。
 * 「止めずに知らせる」方針なので、ここで返るものは保存を妨げない。
 */
export function warningsFrom(items: CheckItem[]): string[] {
  return items.filter((i) => i.level !== 'ok').map((i) => `${i.label}：${i.detail}`);
}

/** パネルの見出しとサマリーに出す件数。 */
export function countLevels(items: CheckItem[]): { ng: number; warn: number; ok: number } {
  return {
    ng: items.filter((i) => i.level === 'ng').length,
    warn: items.filter((i) => i.level === 'warn').length,
    ok: items.filter((i) => i.level === 'ok').length,
  };
}
