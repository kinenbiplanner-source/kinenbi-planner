-- Anniv メディアの記事テーブル。
--
-- カラムは write-article Step 6-4 が出力する frontmatter に合わせている
-- （title / description / keyword / axis / funnel / published / ad）。
-- 管理画面の「article.md を貼り付けて取り込む」がそのまま流し込めるようにするため。

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,          -- 半角英数とハイフンのみ。手入力（自動生成しない）
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,                 -- メタディスクリプション（120字前後）
  keyword      TEXT    NOT NULL,                 -- ターゲットKW
  axis         TEXT    NOT NULL,                 -- gift | date | concierge
  funnel       TEXT    NOT NULL,                 -- 集客 | 比較・検討 | 課題解決
  status       TEXT    NOT NULL DEFAULT 'draft', -- draft | published
  body_md      TEXT    NOT NULL,
  body_html    TEXT    NOT NULL DEFAULT '',      -- 保存時にレンダリング済み
  toc_json     TEXT    NOT NULL DEFAULT '[]',
  hero_image   TEXT,                             -- R2 のキー
  is_ad        INTEGER NOT NULL DEFAULT 0,       -- frontmatter の ad: true
  published_at TEXT,                             -- ISO8601。公開時にセット
  updated_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);

-- 一覧・RSS・sitemap 用（公開記事を新しい順に引く）
CREATE INDEX IF NOT EXISTS idx_articles_pub  ON articles(status, published_at DESC);
-- カテゴリ一覧・関連記事用
CREATE INDEX IF NOT EXISTS idx_articles_axis ON articles(axis, status, published_at DESC);
