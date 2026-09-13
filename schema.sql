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
  -- ── SEO 列（2026-09-10。既存の D1 には migrations/2026-09-10-keywords-seo.sql を scripts/seo/migrate.ts で当てる）──
  -- difficulty / volume（低中高・小中大）は人が読むための粗い目安として残し、機械が出す数字は別列に置く。
  -- 数字が無い（null）と「小」は意味が違う（測っていない／測ったら小さかった）ので、同じ列に混ぜない。
  seed          TEXT    NOT NULL DEFAULT '',   -- 種KW（クラスタ）。同じ種の記事どうしを内部リンクで束ねる単位。カニバリ判定の母集団
  volume_num    INTEGER,                       -- 月間検索数の実数。無ければ null
  volume_source TEXT    NOT NULL DEFAULT '',   -- ahrefs | csv | gsc | ''（keyword-selection.md 4章。上ほど信頼できる）
  demand_score  INTEGER,                       -- サジェスト深度スコア 0〜100（src/lib/seo/demand.ts。候補どうしの相対値で絶対量ではない）
  kd            INTEGER,                       -- Ahrefs の Keyword Difficulty。無ければ null
  serp_grade    TEXT    NOT NULL DEFAULT '',   -- SERP 要塞度 A | B | C | ''（keyword-selection.md 2章。scout が判定）
  serp_note     TEXT    NOT NULL DEFAULT '',   -- 上位10の内訳と根拠（1〜2行）
  researched_at TEXT    NOT NULL DEFAULT '',   -- 最後に SERP・ボリュームを調べた日（YYYY-MM-DD）。古ければ再調査
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kw_status ON keywords(status, priority, id);
CREATE INDEX IF NOT EXISTS idx_kw_axis   ON keywords(axis, priority);

-- ────────────────────────────────────────────────
-- 週次レポート（/anniv-update-pv が入れる）。
--
-- Claude が現状ファクトシートを読んで書いた分析文（Markdown）と、その回の記事別 GA4 / Search Console の断面。
-- /admin/stats がここを読んで本文とGA4・GSC列を出す。**ダッシュボードは D1 を読むだけ**なので、
-- 毎週の更新はこのテーブルに1行入れるだけで済み、デプロイは要らない。
--
-- GA4 と GSC の記事別の数字を Worker から都度引かないのは、GA4 のクォータと GSC の遅延があるうえ、
-- 「レポートを書いた時点の数字」と画面の数字が違うと読みが狂うため。その回の断面をそのまま置く。
-- 書き込みは scripts/update-pv.ts --publish（wrangler 経由）だけ。Worker 側は読むだけ。
CREATE TABLE IF NOT EXISTS pv_reports (
  ymd           TEXT PRIMARY KEY,               -- レポートの日付（JST）。同じ日に何度入れても1件
  report_md     TEXT NOT NULL,                  -- 週次レポート本文（Markdown）
  snapshot_json TEXT NOT NULL DEFAULT '{}',     -- 記事別の断面（src/lib/stats.ts の PvSnapshot）
  created_at    TEXT NOT NULL
);

-- ────────────────────────────────────────────────
-- 競合の観測（2026-09-10）。同業の Instagram 投稿と記事を継続的に取って、
-- Anniv のネタ（SNSネタ台帳）・KW候補（/anniv-pick-keyword）に変換する材料にする。
--
-- 対象（誰を見るか）は `記事管理/競合/targets.json` が正で、scripts/seo/ig-scan.ts と site-scan.ts が
-- 実行のたびにここへ写す（人が編集するのは JSON だけ。D1 は観測結果の置き場）。
-- Worker 側（/admin/competitors）は読むだけ。書くのはローカルのスクリプトだけ（pv_reports と同じ立場）。
--
-- Instagram の取得は Facebook Login 方式の Graph API（Business Discovery）。multi-SNS-manager が
-- 投稿に使っている Instagram Login 方式（graph.instagram.com）には他アカウントを見る機能が無いので、
-- トークンは別に用意する（手順は メディア方針/SNS戦略.md「競合の観測」）。トークンが無い間は
-- 手で見た数字を JSON で取り込む口がある（source='manual'）。
CREATE TABLE IF NOT EXISTS competitor_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT    NOT NULL DEFAULT 'instagram',
  handle      TEXT    NOT NULL,                  -- @ なし
  label       TEXT    NOT NULL DEFAULT '',       -- 表示名（えぽ夫婦 など）
  kind        TEXT    NOT NULL DEFAULT '',       -- couple_media | gift_media | vendor | concierge | other（SNS戦略.md 3章の3タイプ＋同業）
  active      INTEGER NOT NULL DEFAULT 1,
  followers   INTEGER,                           -- 最終取得時。null＝未取得
  media_count INTEGER,
  fetched_at  TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  UNIQUE(platform, handle)
);

CREATE TABLE IF NOT EXISTS competitor_posts (
  id             TEXT    PRIMARY KEY,            -- IG の media id。手動取込は 'manual:<shortcode>'
  account_id     INTEGER NOT NULL,
  media_type     TEXT    NOT NULL DEFAULT '',    -- IMAGE | VIDEO | CAROUSEL_ALBUM
  caption        TEXT    NOT NULL DEFAULT '',
  permalink      TEXT    NOT NULL DEFAULT '',
  posted_at      TEXT    NOT NULL DEFAULT '',    -- ISO8601
  like_count     INTEGER,                        -- 最新の値。推移は competitor_post_stats
  comments_count INTEGER,
  view_count     INTEGER,                        -- リールだけ
  source         TEXT    NOT NULL DEFAULT 'api', -- api | hashtag | manual
  first_seen     TEXT    NOT NULL,
  fetched_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cposts_account ON competitor_posts(account_id, posted_at DESC);

-- 同じ投稿を取り直すたびに1行。「伸びている」は前回との差で見る（合計だけだと分からない。pageviews と同じ思想）
CREATE TABLE IF NOT EXISTS competitor_post_stats (
  post_id        TEXT    NOT NULL,
  ymd            TEXT    NOT NULL,               -- YYYY-MM-DD（JST）
  like_count     INTEGER,
  comments_count INTEGER,
  view_count     INTEGER,
  PRIMARY KEY (post_id, ymd)
);

CREATE TABLE IF NOT EXISTS competitor_sites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT    NOT NULL UNIQUE,            -- anny.gift
  label      TEXT    NOT NULL DEFAULT '',
  adapter    TEXT    NOT NULL DEFAULT '',        -- wp-rest | sitemap | html（取り方。scripts/seo/site-scan.ts）
  entry      TEXT    NOT NULL DEFAULT '',        -- 一覧の URL・sitemap の URL・REST のベース
  active     INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);

-- 競合の記事1本＝1行。新着・更新は first_seen / modified_at で追う。
-- 「伸びているか」は sitemap や HTML からは分からない。Ahrefs（MCP）で取れた回だけ traffic に入る。
CREATE TABLE IF NOT EXISTS competitor_pages (
  url          TEXT    PRIMARY KEY,
  site_id      INTEGER NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  published_at TEXT    NOT NULL DEFAULT '',
  modified_at  TEXT    NOT NULL DEFAULT '',
  first_seen   TEXT    NOT NULL,
  last_seen    TEXT    NOT NULL,
  traffic      INTEGER,                          -- Ahrefs の推定月間トラフィック。null＝未取得
  top_keyword  TEXT    NOT NULL DEFAULT '',      -- Ahrefs の主要KW
  traffic_at   TEXT    NOT NULL DEFAULT ''       -- traffic を取った日
);
CREATE INDEX IF NOT EXISTS idx_cpages_site ON competitor_pages(site_id, first_seen DESC);

-- ────────────────────────────────────────────────
-- 受注（案件）。Tally → Notion 2DB → Make の流れを D1 1テーブルに畳んだもの（2026-09-07）。
--
-- 「顧客管理DB（生ログ）」と「案件管理DB（進行管理）」は実態が同じ1行の前半と後半なので、
-- 生の回答は submission_json に丸ごと持ち、進行の列を同じ行に足す。
-- 申込フォーム（/apply）と無料相談（/contact）は同じテーブルで kind だけ違う。
--
-- code は顧客に見せる受付番号（例 K7M2-4QXA）。サンクスページでこの番号を LINE に送ってもらい、
-- Webhook 側で line_user_id に紐づける（＝「LINE 登録があったか」を管理画面で見られるようにする）。
-- 紛らわしい 0/O/1/I/L は使わない（src/lib/cases.ts の generateCode）。
CREATE TABLE IF NOT EXISTS cases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL UNIQUE,            -- 受付番号 XXXX-XXXX
  kind             TEXT    NOT NULL DEFAULT 'apply',   -- apply（申込フォーム） | consult（無料相談）
  status           TEXT    NOT NULL DEFAULT 'new',     -- src/lib/intake.ts の CASE_STATUSES
  -- 顧客
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL DEFAULT '',
  phone            TEXT    NOT NULL DEFAULT '',
  line_name        TEXT    NOT NULL DEFAULT '',        -- 顧客が申告した LINE の表示名
  line_user_id     TEXT,                               -- 紐づいた LINE の userId（line_users.user_id）
  -- 申込内容（フォームの回答。列は Tally の現行フォーム 2026-09-07 時点と対）
  age              TEXT    NOT NULL DEFAULT '',
  partner_age      TEXT    NOT NULL DEFAULT '',
  relationship     TEXT    NOT NULL DEFAULT '',        -- 交際期間
  anniversary      TEXT    NOT NULL DEFAULT '',        -- 記念日の内容
  anniversary_date TEXT    NOT NULL DEFAULT '',        -- YYYY-MM-DD
  budget           TEXT    NOT NULL DEFAULT '',
  express          INTEGER NOT NULL DEFAULT 0,         -- スピード対応
  delegation       TEXT    NOT NULL DEFAULT '',        -- お任せ度合い 100 | 70 | 30
  interests_json   TEXT    NOT NULL DEFAULT '[]',      -- パートナーの興味（配列）
  past_style       TEXT    NOT NULL DEFAULT '',        -- これまでの過ごし方
  wishes           TEXT    NOT NULL DEFAULT '',        -- 希望・こだわり
  message          TEXT    NOT NULL DEFAULT '',        -- 無料相談の相談内容
  submission_json  TEXT    NOT NULL DEFAULT '{}',      -- 生の回答（そのまま）
  source           TEXT    NOT NULL DEFAULT 'direct',  -- 流入元（track.js が持つ UTM）
  medium           TEXT    NOT NULL DEFAULT '',
  campaign         TEXT    NOT NULL DEFAULT '',
  -- 進行（旧 Notion 案件管理DB の列）
  plan             TEXT    NOT NULL DEFAULT '',
  gift             TEXT    NOT NULL DEFAULT '',
  gift_arranged    INTEGER NOT NULL DEFAULT 0,
  gift_shipped_on  TEXT    NOT NULL DEFAULT '',
  restaurant       TEXT    NOT NULL DEFAULT '',
  restaurant_booked INTEGER NOT NULL DEFAULT 0,
  guide_sent       INTEGER NOT NULL DEFAULT 0,         -- 演出指示書を送ったか
  payment_method   TEXT    NOT NULL DEFAULT 'stripe',  -- stripe | paypay | other
  payment_status   TEXT    NOT NULL DEFAULT 'none',    -- none | sent | paid | refunded
  amount           INTEGER NOT NULL DEFAULT 0,         -- 円
  stripe_invoice_id TEXT   NOT NULL DEFAULT '',
  memo             TEXT    NOT NULL DEFAULT '',
  -- 詳しいアンケート（/survey）に答えた日時。**null なら未回答**。
  -- 入口の /apply では お名前・メール・LINE名 の3つしか聞かないので、
  -- ここが空の案件は提案に必要な情報がまだ揃っていない（2026-09-07 に2段階化）。
  survey_at        TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_line   ON cases(line_user_id);
CREATE INDEX IF NOT EXISTS idx_cases_date   ON cases(anniversary_date);

-- 案件の履歴（誰がいつ何をしたか。Notion のコメント欄の代わり）
CREATE TABLE IF NOT EXISTS case_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,                 -- created | status | note | mail | line_out | line_in | link | unlink
  body       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_log ON case_log(case_id, id);

-- ────────────────────────────────────────────────
-- LINE 公式アカウントの友だち（Messaging API の Webhook が入れる）。
-- follow で行を作り、unfollow で unfollowed_at を立てる（行は消さない。再追加で戻す）。
CREATE TABLE IF NOT EXISTS line_users (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL DEFAULT '',
  picture_url     TEXT NOT NULL DEFAULT '',
  followed_at     TEXT NOT NULL,
  unfollowed_at   TEXT,
  last_message_at TEXT,
  -- ── アンケートの本人確認トークン（2026-09-10。既存の D1 には
  --    migrations/2026-09-10-line-survey-token.sql を scripts/seo/migrate.ts で当てる）──
  --
  -- 友だち追加のときに push する案内リンクを `/survey?t=<survey_token>` にするためのもの。
  -- **こちらが特定のトークルームへ送ったURL**なので、持っている＝そのLINEアカウント本人。
  -- 時刻の近さで推測する紐づけ候補（cases.ts の rankLinkCandidates）と違い、
  -- 他人に結びつく余地が無いので、回答と同時に cases.line_user_id を自動で埋められる。
  --
  -- 一度発行したら作り直さない。過去のトークに残っているリンクを生かしたままにするため
  -- （空文字＝未発行。src/lib/line.ts の issueSurveyToken）。
  survey_token    TEXT NOT NULL DEFAULT '',
  survey_token_at TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL
);

-- LINE のやり取り（受信は Webhook、送信は管理画面から push したもの）。
-- 顧客対応そのものは LINE Official Account Manager のチャットで続ける前提なので、
-- ここに全会話を再現する意図は無い。「いつ何を送った／受けたか」の控え。
CREATE TABLE IF NOT EXISTS line_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  direction  TEXT NOT NULL,                    -- in | out
  text       TEXT NOT NULL DEFAULT '',
  event_at   TEXT NOT NULL,
  raw_json   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_line_msg ON line_messages(user_id, id DESC);
