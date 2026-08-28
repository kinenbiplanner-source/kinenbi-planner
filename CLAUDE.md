# kinenbi-planner（Anniv）プロジェクトメモ

Anniv（記念日のプレゼント選び・レストラン予約・サプライズ演出をトータルサポートするサービス。本番：`https://anniv.gift`）のLP・運用リポジトリ＋自社メディア記事制作システム。

## トップレベル構成

- `public/` — 本番LPの静的ファイル（旧 `lp/`）。素のHTMLのまま Astro が無加工で配信する。**URLは従来どおり**（`/`、`/contact.html` など）
- `src/` — Astroのメディア基盤。`pages/media/`（一覧・記事）・`pages/admin/`（記事の投稿・編集・キーワード台帳・**メディア分析** `/admin/stats`）・`pages/api/`（保存・プレビュー・画像アップロード・CSV出力・PV計測）・`lib/`（D1アクセス・Markdownレンダラー・軸定義・**PV集計** `stats.ts`・**広告設定** `ads.ts`）・`layouts/` ・`components/` ・`styles/`
  - 「見る画面」は4つあって別物：`/admin/stats`（自前PV。記事ごとの相対比較とリライト判断）／ GA4（流入元・行動の詳細）／ **`/dashboard/measurement`（CV・導線クリック・流入元。自前とGA4を列を分けて並べる。中身は `計測ダッシュボード.html`）** ／ `/dashboard`（事業側の固定費と各サービスの入口。中身は `ダッシュボード.html`）
  - **計測は `/dashboard` から切り出した**（2026-08-28）。画面の大半を占めて固定費とサービスの入口が埋もれたため。`/dashboard` に残っているのは入口のバー1本だけで、データの出どころ（`/api/insights`・`/api/ga4`）は変えていない。`/admin` のヘッダーからも「計測」で飛べる
  - `/dashboard` のコスト欄にある「SNS運用（今月の実績）」は**別プロジェクト multi-SNS-manager（`C:\dev\multi-SNS-manager` / 本番 `anniv-tool.date`）のD1を読み取り専用で参照している**（`SNS_DB` バインディング → `src/lib/sns-cost.ts` → `/api/sns-cost`）。あちらの `cost_events` / `cost_settings` の列名に依存するので、壊れたら真っ先にそこを疑う（読めないときは金額を出さず「—」に落とす作り）
- `astro.config.mjs` / `wrangler.jsonc` / `schema.sql` — ビルドとCloudflareの設定。**Astro 7 ＋ `@astrojs/cloudflare` で Cloudflare Workers にデプロイ**（root dir はリポジトリルート）
- **記事の実体は Cloudflare D1**（`articles` テーブル。スキーマは `schema.sql` が正）。画像は R2（`anniv-media`）
- `.claude/agents/` — 記事制作サブエージェント定義（competitor-researcher / article-writer / article-reviewer）
  - `.claude/agents/reference/` — 記事制作の共有SSOT資料（article-style-guide.md / content-axis.md / interview-sheet.md / improvement-loop.md / 社内ナレッジ.md）
- `.claude/skills/` — 記事制作オーケストレーター（anniv-write-article / anniv-rewrite-article）＋ 要約カード生成（anniv-card）。**すべて `anniv-` 始まり**——グローバル（爆速開発部）側に同名のスキルがあり、`/write-article` と打つとそちらが読まれてしまうため
- `scripts/` — 運用スクリプト。`put-draft.ts`（書き上がった `article.md` を記事エディタの下書きとしてD1に入れる。anniv-write-article Step 6-6 から呼ぶ）
- `.claude/scripts/card-renderer/` — 要約カードのレンダラー（`render.py`＋`template.html`＋`icons.json`＋`to_webp.mjs`）。**ブランドカラーは template.html の `:root`**（`src/styles/tokens.css` と同じネイビー×ゴールド。爆速開発部側の青りんご版とは別物なので混同しない）
- `記事/` — 記事の作業フォルダ（下書き。`article.md`として保存。要約カードは `記事/[KW名]/images/*.webp`）
- `素材/` — 記事本文に差し込むフリー写真素材（CC0のみ・62枚）。何がどれかは `素材/一覧.md`。使うときは管理画面から**R2にアップロードして** `/media/img/<key>` で参照する（ローカルパス参照は公開先で壊れる）
- `記事管理/` — KWマスターDB.csv（記事の管理台帳）・アフィリ案件マスター.csv（ヘッダーのみの雛形。将来アフィリを始める時に使う）・リサーチマスター.md（リサーチ結果の鮮度付きキャッシュ、必要になったら生成）
- `メディア方針/` — メディア戦略.md（コンセプト・差別化軸・着手順・KPIなどメディア運営方針のSSOT）・計測設計.md（GA4/Pixelのイベント定義のSSOT。**導線を足したら必ずここも更新する**）・**改良ロードマップ.md（これから何をするかの一覧。作業を始める前にまずここを見る）**・収益化メモ.md（**AdSenseは導入決定**。受け皿は実装済みで、審査と設定の手順もここ。アフィリは未定）・SNS戦略.md（Instagram／XのSSOT。役割分担・計測・コスト・広告）・**投稿台本.md（SNSの実行ぶん。12/24までのカレンダーと原稿。投稿する日はこれだけ開けばいい）**

## 記事制作システムについて

爆速開発部メディア（別プロジェクト）で運用していた記事制作の仕組み（AIエージェント3体＋オーケストレーター2本）をAnniv向けに移植したもの。コンテンツ軸・自己言及ルール・DBパスなどはAnniv仕様に書き換え済み。運営方針の背景・意思決定理由は `メディア方針/メディア戦略.md` を参照。

- 記事を新規で書く：`/anniv-write-article <KW>`（H3が2個以上あるH2には要約カードが自動で入る）
- 既存記事をリライトする：`/anniv-rewrite-article <KW or ファイルパス>`
- 要約カードを単発で作る：`/anniv-card`（H2＋H3の本文を貼る）
- **記事を公開する**：`/anniv-write-article` は `article.md` を保存した時点で**下書きとして本番D1に入れる**（`scripts/put-draft.ts`）。出てきた `https://anniv.gift/admin/<id>/edit` を開き、slug を入力 → プレビューと公開前チェックを確認 → 公開。**リポジトリにMarkdownを置いても公開されない**（記事はD1にある）
  - 手で入れたいときは `/admin/new` の本文欄に `article.md` の全文（frontmatter込み）をそのまま貼れば同じ状態になる（frontmatter はメタ情報に自動で移る）
  - **slug は未設定のままでも下書き保存できる**（＝一時保存）。公開のときだけ必須
  - **スラッグは公開後に変えない**。日付も入れない（URL変更＋301欠落で検索評価がリセットされた実害が爆速開発部にある）
  - 公開したら管理画面の「CSVエクスポート」で `記事管理/KWマスターDB.csv` を丸ごと上書きする（手でURLを転記しない）
  - **要約カードを入れた記事は、本文を貼ったあと管理画面の「画像をアップロード」で `images/card_XX.webp` を上げ、`![alt](/media/img/<key>)` に差し替える**（ローカルパスのままだと公開先で壊れる。公開前チェックが×で拾う）
  - 詳細な手順は `.claude/skills/anniv-write-article/SKILL.md` の Step 6-6／6-7
- ルール変更：文体・骨格・SEOなど全軸共通のルールは `.claude/agents/reference/article-style-guide.md` を編集。コンテンツ軸（テーマ・リサーチ観点・文体の寄せ）は `.claude/agents/reference/content-axis.md` を編集

**元の爆速開発部フローから未移植・簡略化した部分**（必要になったら元プロジェクト `C:\Users\sansh\OneDrive\爆速開発部\_config` を参照して移植する）：
- アフィリエイト運用（`記事管理/アフィリ案件マスター.csv` はヘッダーのみの雛形。Annivは現状Anniv送客CTAのみで、案件データは未投入。レストラン予約サイト等との提携を将来検討する可能性があり、始めるときはstyle-guide 19章の仕組みをStep 0のフォームに復元する）
- 公開後のローカルmd自動削除（`publish_article.py` 相当）。Annivでは `記事/[KW名]/article.md` をリライトの元原稿として残す運用にしたので移植していない

## 記事制作システムの運用メモ（実態に合わせた調整）

- **軸3（記念日代行・サプライズ代行サービス）の自己言及は実績控えめ**：Annivはまだ実績が少ない立ち上げ期のため、「手がけてきた」「多数の実績」のような実績の量・年数を暗示する表現は禁止（style-guide 2章）。実績が積み上がったら見直す。
- **一次知見の集め方は「取材」ではなく「自問自答」**：実際にプレゼント選定・演出をプロデュースしているのはユーザー自身（小規模運営）なので、anniv-write-article Step 3.5は外部の担当者に送る取材シートではなく、その場でユーザーに質問してチャットで直接回答してもらう形にしてある（`.claude/agents/reference/interview-sheet.md`）。
- **記事の公開先は `anniv.gift/media/` のサブディレクトリ**（サブドメインは不採用。根拠はメディア戦略.md 8章）。実装済み。記事はD1に置き、`/media/<slug>` でオンデマンドレンダリングする（公開ボタンから最長60秒で反映＝エッジキャッシュの `s-maxage=60`）。
- **記事の着手順は軸1→軸2→軸3**：軸3（受注直結）はKWがニッチで検索ボリュームが小さいため、軸1（検索ボリュームのある集客記事）で入口を作ってから内部リンクで軸3・無料相談に橋渡しする王道パターンにしている（メディア戦略.md 3章・7章）。
- **SEOはSNS運用と並行するチャネルの一つ**：CVへの主力は将来的にSNS（Instagram/X、有料広告含む）と想定しており、このリポジトリのSEO記事制作システムはその一部という位置づけ（メディア戦略.md 4章）。SNS運用自体はスコープ外。
