-- Anniv メディアの記事テーブル。
--
-- カラムは anniv-write-article Step 6-4 が出力する frontmatter に合わせている
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
-- 導線のイベント（自前計測）。
--
-- GA4 にも同じ行為を飛ばしているが、**GA4の数字はGA4の画面にしか無い**ので、
-- /dashboard に出す数字はここから引く（pageviews と同じ思想。GA4の値とは必ずズレるので
-- 突き合わせない。GA4は詳細な行動分析を見る場所として残す）。
--
-- **1イベント1行にしない。** 日付×イベント×発火場所×流入元で1行に畳む。
-- 個票が要る分析はGA4側でやる前提で、こちらはD1の書き込み量と行数を抑える方を取る。
--
-- 列が増えるほど組み合わせが増えて行が膨らむので、**値は受け口（/api/ev）で必ず正規化する**：
--   name   … 許可リストのみ（未知の名前は捨てる）
--   label  … [a-z0-9_-] に落として32字で切る
--   source … 許可リスト＋未知は 'other'、UTMが無ければ referrer から推定（既定 'direct'）
-- 正規化を外すと、いたずらでも自然な流入でも PRIMARY KEY の組み合わせが際限なく増える。
CREATE TABLE IF NOT EXISTS event_daily (
  ymd      TEXT    NOT NULL,              -- YYYY-MM-DD（JST）
  name     TEXT    NOT NULL,              -- page_view | cta_click | line_add_click | links_click | follow_click | form_complete | form_error | article_feedback
  label    TEXT    NOT NULL DEFAULT '',   -- 発火場所（index_cta / article_body …）。follow_click と links_click だけ行き先が入る
  source   TEXT    NOT NULL DEFAULT 'direct',  -- utm_source。instagram | x | tiktok | meta_ads | google | other | direct
  medium   TEXT    NOT NULL DEFAULT '',   -- utm_medium。profile | story | post | paid | organic …
  campaign TEXT    NOT NULL DEFAULT '',   -- utm_campaign。投稿の識別子（台本のカレンダーと1対1にする）
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ymd, name, label, source, medium, campaign)
);
CREATE INDEX IF NOT EXISTS idx_ev_ymd    ON event_daily(ymd);
CREATE INDEX IF NOT EXISTS idx_ev_name   ON event_daily(name, ymd);
CREATE INDEX IF NOT EXISTS idx_ev_source ON event_daily(source, ymd);

-- ────────────────────────────────────────────────
-- 記事化するキーワードの管理台帳。
-- これまで 記事管理/KWマスターDB.csv でやっていたことをDB側に持つ。
-- CSVは引き続き管理画面からエクスポートできる（anniv-write-article が参照するため）。
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
