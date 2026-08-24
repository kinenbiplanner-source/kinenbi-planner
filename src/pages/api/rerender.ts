/**
 * 全記事の再レンダリング（POST /api/rerender）。
 *
 * body_html / toc_json は保存時に1回だけ作る設計なので、
 * src/lib/markdown.ts を直した（記法を足した・CSSクラス名を変えた）ときは
 * 既存記事の HTML が古いままになる。その差を埋めるための管理操作。
 *
 * updated_at は意図的に触らない。あれは「記事の中身を書き換えた日」であり、
 * CSVのリライト日と記事の dateModified の元になる。レンダラーの都合で
 * 全記事の更新日が今日に飛ぶと、リライト計画の判断材料が壊れる。
 */
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { renderArticle } from '../../lib/markdown';

export const prerender = false;

export const POST: APIRoute = async () => {
  const { results } = await db()
    .prepare('SELECT id, body_md FROM articles ORDER BY id')
    .all<{ id: number; body_md: string }>();

  const rows = results ?? [];
  if (!rows.length) {
    return json({ count: 0, message: '記事がありません' });
  }

  const stmt = db().prepare('UPDATE articles SET body_html=?, toc_json=? WHERE id=?');
  const statements = rows.map((r) => {
    const rendered = renderArticle(r.body_md);
    return stmt.bind(rendered.html, JSON.stringify(rendered.toc), r.id);
  });

  // batch は1トランザクションで走るので、途中で落ちても中途半端な状態が残らない。
  await db().batch(statements);

  return json({ count: rows.length, message: `${rows.length}件の記事を再レンダリングしました` });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}
