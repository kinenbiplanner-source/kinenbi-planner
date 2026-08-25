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

-- ────────────────────────────────────────────────
-- 記事のPV。
-- 日付ごとに1行持つ（推移が見たいため。合計だけだと施策の効果が測れない）。
-- 記事ページはエッジで60秒キャッシュされるので、レンダリング時ではなく
-- クライアントからのビーコン（POST /api/pv）で加算する。
CREATE TABLE IF NOT EXISTS pageviews (
  article_id INTEGER NOT NULL,
  ymd        TEXT    NOT NULL,   -- YYYY-MM-DD（JST）
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, ymd)
);
CREATE INDEX IF NOT EXISTS idx_pv_article ON pageviews(article_id);
CREATE INDEX IF NOT EXISTS idx_pv_ymd     ON pageviews(ymd);

-- ────────────────────────────────────────────────
-- 記事化するキーワードの管理台帳。
-- これまで 記事管理/KWマスターDB.csv でやっていたことをDB側に持つ。
-- CSVは引き続き管理画面からエクスポートできる（write-article が参照するため）。
CREATE TABLE IF NOT EXISTS keywords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword    TEXT    NOT NULL UNIQUE,
  axis       TEXT    NOT NULL,              -- gift | date | concierge
  funnel     TEXT    NOT NULL,              -- 集客 | 比較・検討 | 課題解決
  intent     TEXT    NOT NULL DEFAULT '',   -- 検索意図
  persona    TEXT    NOT NULL DEFAULT '',   -- 想定読者
  difficulty TEXT    NOT NULL DEFAULT '中', -- 低 | 中 | 高
  volume     TEXT    NOT NULL DEFAULT '中', -- 小 | 中 | 大
  priority   INTEGER NOT NULL DEFAULT 2,    -- 1が最優先
  status     TEXT    NOT NULL DEFAULT 'todo', -- todo | writing | done | dropped
  article_id INTEGER,                       -- 記事化されたら articles.id を入れる
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kw_status ON keywords(status, priority, id);
CREATE INDEX IF NOT EXISTS idx_kw_axis   ON keywords(axis, priority);
