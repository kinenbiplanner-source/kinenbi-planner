/**
 * プレビュー（POST /api/preview）と、article.md の取り込み（mode: 'import'）。
 *
 * プレビューは保存時とまったく同じ renderArticle を通す。ここを別実装にすると
 * 「プレビューでは崩れていないのに本番で崩れる」が起きるので、経路は必ず1本に保つ。
 *
 * 取り込みを専用APIに分けず mode で足しているのは、frontmatter.ts が
 * サーバ側モジュール（axis.ts に依存）でクライアントから直接呼べない一方、
 * 取り込みのためだけにエンドポイントを増やすと防御すべき面が広がるため。
 * 取り込みは「パースしてプレビューも返す」1往復で済ませる。
 */
import type { APIRoute } from 'astro';
import { renderArticle } from '../../lib/markdown';
import { parseArticle } from '../../lib/frontmatter';

export const prerender = false;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

export const POST: APIRoute = async ({ request }) => {
  let raw: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const source = typeof raw.body_md === 'string' ? raw.body_md : '';

  if (raw.mode === 'import') {
    const parsed = parseArticle(source);
    const rendered = renderArticle(parsed.body);
    return json({
      parsed: {
        title: parsed.title,
        description: parsed.description,
        keyword: parsed.keyword,
        axis: parsed.axis,
        funnel: parsed.funnel,
        published: parsed.published,
        isAd: parsed.isAd,
        body: parsed.body,
        // frontmatter が無い＝本文だけ貼られた。管理画面側で
        // 「メタ情報は手入力してください」と案内するために返す。
        bodyOnly: parsed.bodyOnly,
      },
      html: rendered.html,
      toc: rendered.toc,
      imagePlaceholders: rendered.imagePlaceholders,
    });
  }

  const rendered = renderArticle(source);
  return json({
    html: rendered.html,
    toc: rendered.toc,
    imagePlaceholders: rendered.imagePlaceholders,
  });
};
