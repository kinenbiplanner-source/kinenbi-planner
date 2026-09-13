# kinenbi-planner（Anniv）プロジェクトメモ

Anniv（記念日のプレゼント選び・レストラン予約・サプライズ演出をトータルサポートするサービス。本番：`https://anniv.gift`）のLP・運用リポジトリ＋自社メディア記事制作システム。

## トップレベル構成

- `public/` — 本番LPの静的ファイル（旧 `lp/`）。素のHTMLのまま Astro が無加工で配信する。**URLは従来どおり**（`/`、`/contact.html` など）
- `src/` — Astroのメディア基盤。`pages/media/`（一覧・記事）・`pages/admin/`（記事の投稿・編集・キーワード台帳・**メディア分析** `/admin/stats`・**SEO分析** `/admin/seo`）・`pages/api/`（保存・プレビュー・画像アップロード・CSV出力・PV計測）・`lib/`（D1アクセス・Markdownレンダラー・軸定義・**PV集計** `stats.ts`・**広告設定** `ads.ts`・**SEO判定** `seo/`）・`layouts/` ・`components/` ・`styles/`
  - 「見る画面」は6つあって別物（**`/admin/competitors`（同業の伸びている投稿・記事。2026-09-10）**を含む）：`/admin/stats`（自前PV。記事ごとの相対比較とリライト判断。**週次レポートと記事別の GA4・GSC の断面もここに出る**＝ `/anniv-update-pv` が D1 の `pv_reports` に入れる）／ **`/admin/seo`（書く前に見る。台帳と記事のカニバリ・内部リンクの孤立と提案・GSC断面のカニバリ実測と striking distance・台帳のSEO列の未調査一覧。2026-09-10）** ／ GA4（流入元・行動の詳細）／ **`/dashboard/measurement`（CV・導線クリック・流入元。自前とGA4を列を分けて並べる。中身は `計測ダッシュボード.html`）** ／ `/dashboard`（事業側の固定費と各サービスの入口。中身は `ダッシュボード.html`）
  - **`src/lib/seo/`（2026-09-10）** は `cloudflare:workers` に依存しない純粋関数だけ（管理画面と `scripts/seo/` の両方から import するため。相対 import は `.ts` 付き）。`types.ts`（共有型）／`tokens.ts`（分かち書き・**同義グループ**＝「ディナー＝レストラン」「相場＝予算」等はここ。複合語「誕生日プレゼント」も既知語で割る）／`cannibal.ts`（dup／strong／weak の3段）／`internal-links.ts`（リンクグラフ・孤立・提案）／`serp.ts`（要塞度 A/B/C の閾値。**`keyword-selection.md` 2章の写し。片方だけ変えない**）／`demand.ts`（サジェスト深度スコア＝相対値で絶対量ではない）／`volume.ts`（キープラ／ラッコ CSV のパース）。台帳の SEO 列（`seed` `volume_num` `volume_source` `demand_score` `kd` `serp_grade` `serp_note` `researched_at`）は `schema.sql` が正で、**既存の D1 には `migrations/` を `scripts/seo/migrate.ts` で当てる**（何度流しても安全）
  - **計測は `/dashboard` から切り出した**（2026-08-28）。画面の大半を占めて固定費とサービスの入口が埋もれたため。`/dashboard` に残っているのは入口のバー1本だけで、データの出どころ（`/api/insights`・`/api/ga4`）は変えていない。`/admin` のヘッダーからも「計測」で飛べる
  - `/dashboard` のコスト欄にある「SNS運用（今月の実績）」は**別プロジェクト multi-SNS-manager（`C:\dev\multi-SNS-manager` / 本番 `anniv-tool.date`）のD1を読み取り専用で参照している**（`SNS_DB` バインディング → `src/lib/sns-cost.ts` → `/api/sns-cost`）。あちらの `cost_events` / `cost_settings` の列名に依存するので、壊れたら真っ先にそこを疑う（読めないときは金額を出さず「—」に落とす作り）
- `astro.config.mjs` / `wrangler.jsonc` / `schema.sql` — ビルドとCloudflareの設定。**Astro 7 ＋ `@astrojs/cloudflare` で Cloudflare Workers にデプロイ**（root dir はリポジトリルート）。**デプロイは `npm run deploy` を手で叩く。git push では本番は変わらない**（Workers Builds を繋いでいない。詳細は `メディア方針/改良ロードマップ.md` の「本番への反映は push では起きない」）
- **記事の実体は Cloudflare D1**（`articles` テーブル。スキーマは `schema.sql` が正）。画像は R2（`anniv-media`）
- `.claude/agents/` — 記事制作サブエージェント定義（competitor-researcher / article-writer / article-reviewer / article-naturalizer / **serp-difficulty-scout**）
  - `article-naturalizer` は最後（Step 5.5）に本文を1文ずつ読み返して「人間が書かない言い回し」だけを直す。**参照ファイルを持たない自己完結型**で、style-guide も content-axis も読まない（判定を「人間が書くか」の一点に絞るため）
  - `serp-difficulty-scout` は `/anniv-pick-keyword` Step 4 専用。上位10の顔ぶれを7分類して件数を返すだけ（本文は読まない）。**A/B/C はコード（`src/lib/seo/serp.ts`）で検算し、食い違ったらコードを採る**（閾値の忖度を防ぐ）。自己完結型で、分類表と判定基準はオーケストレーターが `keyword-selection.md` 2章を逐語コピーして渡す
  - `.claude/agents/reference/` — 記事制作の共有SSOT資料（article-style-guide.md / content-axis.md / **keyword-selection.md（KW選定の判定基準。5観点・要塞度A/B/C・ファネル層・需要の数字の優先順位・除外・優先順位）** / interview-sheet.md / improvement-loop.md / 社内ナレッジ.md）
- `.claude/skills/` — 記事制作オーケストレーター（anniv-write-article / anniv-rewrite-article）＋ **KW選定（anniv-pick-keyword）＋ 競合リサーチ単独（anniv-research）**＋ 要約カード生成（anniv-card）＋ **SNS原稿の隔週バッチ生成（anniv-sns-batch）**＋ **PV更新と週次レポート（anniv-update-pv。週1）**。**すべて `anniv-` 始まり**——グローバル（爆速開発部）側に同名のスキルがあり、`/write-article` と打つとそちらが読まれてしまうため
- `scripts/` — 運用スクリプト。`put-draft.ts`（書き上がった `article.md` を記事エディタの下書きとしてD1に入れる＋本文のローカル画像をR2に上げて `/media/img/<key>` に差し替える。anniv-write-article Step 6-4 から呼ぶ）・**`update-pv.ts`（`/anniv-update-pv` の本体。D1の自前PV＋GA4＋Search Console を取って KWマスターDB.csv／PV履歴.csv／現状ファクトシート.md を書き、`--publish` で週次レポートを D1 に入れる。ファクトシートには GSC が取れた回だけ「カニバリ（実測）」「未カバーのクエリ（＝新KW候補）」「リライト優先度」の節も出る）**・**`seo/`（`/anniv-pick-keyword` の手足。`suggest.ts`＝Google補完APIでサジェスト展開＋需要スコア＋既出・カニバリ判定 → `記事管理/KW候補/<日付>_<軸>.json`／`volume.ts`＝候補JSONに検索数を書き戻す（`--ahrefs` ＞ `--csv` ＞ `--gsc` の順で上位が勝つ）／`add-keywords.ts`＝verdict が win/hold の候補を D1 台帳へ／`links.ts`＝内部リンク提案（`--kw` `--slug` `--orphans` `--all`）／`migrate.ts`＝`migrations/` の列追加を D1 に当てる／`_d1.ts`＝wrangler 経由の D1 共通部品。全部 `node --experimental-strip-types scripts/seo/<name>.ts`）**
- `.claude/scripts/card-renderer/` — 要約カードのレンダラー（`render.py`＋`template.html`＋`icons.json`＋`to_webp.mjs`）。**ブランドカラーは template.html の `:root`**（`src/styles/tokens.css` と同じネイビー×ゴールド。爆速開発部側の青りんご版とは別物なので混同しない）
- `.claude/scripts/ig-renderer/` — **Instagramカルーセルのレンダラー**（`render.mjs`＋`template.html`。ブランドカラーは card-renderer と同じ）。`記事管理/SNS原稿/ig_<日付>/spec.json` に投稿台本の原稿を書いて `node .claude/scripts/ig-renderer/render.mjs <spec.json>` を叩くと、1080×1350 の JPEG が枚数ぶん同じフォルダに出る。**見た目の芯は `素材/ブランド/ig-light.png`・`ig-dark.png`（ロゴ入りのブランド背景。全スライドがこのどちらかを敷く。`render.mjs` がこのパスを直接読む）**で、写真は全面に敷かず表紙の円セルに切り抜いて置く（`素材/写真/` のCC0写真）。本文は light、表紙と締めは dark、本文が長くて光の面からはみ出すときは `"bg":"dark"` で逃がす（はみ出しは実行時に警告が出る）。キャプションは同じフォルダの `caption.txt`。並べて確認するときは `sheet.mjs`。投稿は anniv-tool.date のコンポーザーに手で載せる（IGは画像が要るので受信箱の自動取り込みは通らない）
- `記事/` — 記事の作業フォルダ（下書き。`article.md`として保存。要約カードは `記事/[KW名]/images/*.webp`）
- `素材/` — **素材はここ1か所**（2026-09-13 に `広告素材/`・`ブランド素材/`・`ig-renderer/bg/` を畳んだ。索引は `素材/README.md`）。`写真/`＝記事本文に差し込む CC0 の写真・62枚（何がどれかは `写真/一覧.md`。使うときは管理画面から**R2にアップロードして** `/media/img/<key>` で参照する＝ローカルパス参照は公開先で壊れる）／`ブランド/`＝ロゴ・IG カルーセルの背景 `ig-light.png` `ig-dark.png`・背景の候補 `背景1/4〜7.png`・記事アイキャッチ用 `記事背景.png`／`広告/`＝Meta 広告のバナーと `specs/`。**`public/assets/` は配信用で素材置き場ではない**（素材を公開面で使うときは R2 か `public/assets/` にコピーする）
- `記事管理/` — KWマスターDB.csv（記事の管理台帳。**D1から吐き出す派生物で手で編集しない**。従来9列＋PV列。列定義は `src/lib/kw-csv.ts`）・**PV履歴.csv（`/anniv-update-pv` の日付スナップショット）・PVレポート/（現状ファクトシート.md＝スクリプトが毎回再生成する分析材料／週次レポート_YYYY-MM-DD.md＝Claudeが書いた数字の読みとリライト判定。最新の1件は `/admin/stats` にも出る）**・**SNSネタ台帳.csv（SNS投稿ネタのSSOT。`工程×状況` のマスで管理し、`posts.idea_key` でアプリ側と紐づく）**・**SNS原稿/`<batchId>`/（`/anniv-sns-batch` が出す x.json と th.json。受信箱がファイルとして読み込む）**・アフィリ案件マスター.csv（ヘッダーのみの雛形。将来アフィリを始める時に使う）・リサーチマスター.md（リサーチ結果の鮮度付きキャッシュ。competitor-researcher が読み、`/anniv-write-article` Step 1 と `/anniv-research` が更新する）・**KW候補/（`/anniv-pick-keyword` の中間成果物。候補JSON＝誰がどの列を書くかが SKILL に表で決まっている。D1 に入った後も「なぜ落としたか」の記録として消さない）・ボリューム/（Ahrefs MCP の結果 JSON や、キーワードプランナー／ラッコの CSV を置く。`volume.ts` が読む）・リサーチ/（`/anniv-research` の生出力。`<KW>.md`）**
- `メディア方針/` — メディア戦略.md（コンセプト・差別化軸・着手順・KPIなどメディア運営方針のSSOT）・計測設計.md（GA4/Pixelのイベント定義のSSOT。**導線を足したら必ずここも更新する**）・**改良ロードマップ.md（これから何をするかの一覧。作業を始める前にまずここを見る）**・収益化メモ.md（**AdSenseは導入決定**。受け皿は実装済みで、審査と設定の手順もここ。アフィリは未定）・SNS戦略.md（Instagram／X／ThreadsのSSOT。役割分担・計測・コスト・広告）・**投稿台本.md（SNSの実行ぶん。12/24までのカレンダーと原稿。投稿する日はこれだけ開けばいい）**

- **`受注フロー.md` — 受注からサービス提供までの仕組みのSSOT（2026-09-07に自前化）。** Tally・Make・Notion を anniv.gift の Worker に畳み、申込は D1 `cases` に入る。**LINE は残す**（顧客との対話そのもの。Messaging API の Webhook で友だち追加を拾い、顧客が受付番号をトークに送ると案件と自動で紐づく）。Stripe も残す。環境変数・LINE／Resend／Turnstile の設定手順・Tally を止める順番まで全部そこに書いてある

## 記事制作システムについて

爆速開発部メディア（別プロジェクト）で運用していた記事制作の仕組み（AIエージェント3体＋オーケストレーター2本）をAnniv向けに移植したもの。コンテンツ軸・自己言及ルール・DBパスなどはAnniv仕様に書き換え済み。運営方針の背景・意思決定理由は `メディア方針/メディア戦略.md` を参照。

- **次に書くKWを決める：`/anniv-pick-keyword <軸>`**（2026-09-10。サジェスト展開 → 需要の数字（Ahrefs MCP ＞ 手動CSV ＞ GSC表示数 ＞ 需要スコア。**CSV を待たない**）→ SERP要塞度（scout 並列＋コードで検算）→ 勝ち筋／保留／書かない → 次の1本を選ぶ → D1 台帳へ。停止点は軸選択（引数省略時）と「次の1本」の2つだけ。判定基準は `keyword-selection.md`）
  - **Ahrefs は「繋がっていれば使う」**。`claude mcp add ahrefs https://api.ahrefs.com/mcp/mcp -t http` で登録し、対話セッションの `/mcp` で OAuth 認証すると、Keywords Explorer の検索数・KD をエージェントが直接取る。無ければ需要スコア（サジェスト深度＝候補どうしの相対順のみ）で進む。**契約（Lite ¥19,900/月）はユーザーの判断で、設計はどちらでも動く**
- **競合リサーチだけ先に回す：`/anniv-research <KW>`**（competitor-researcher を記事を書かずに単独起動。生出力を `記事管理/リサーチ/<KW>.md` に残す。KW選定の裏取り・リライト前の再確認用）
- **同業の伸びている投稿・記事を観測してネタとKWに変換する：`/anniv-competitor`**（2026-09-10。隔週。`scripts/seo/ig-scan.ts`＝Instagram の競合アカウントの投稿（Business Discovery。**鍵は `.dev.vars` の `IG_GRAPH_TOKEN` / `IG_BUSINESS_ID`。未設定の間は手で見た数字を `--template` → `--import` で入れる**）／`site-scan.ts`＝競合サイトの新着・更新記事（伸びは Ahrefs が要る）→ `記事管理/競合/IG観測_*.md` `記事観測_*.md` → Claude が SNS戦略.md 4章の物差し（中央値比・相手・数字・規則6の独壇場）で読んで `レポート_*.md` → **承認後に `SNSネタ台帳.csv` へ行を足し、種KWを `/anniv-pick-keyword` に渡す**。観測対象は `記事管理/競合/targets.json` だけ人が編集し、D1 `competitor_*` は観測結果の置き場（`/admin/competitors` が読む）。**取得は公式APIだけ。スクレイピングはしない**（@anniv.gift 本体が巻き込まれる）。設定手順は `メディア方針/SNS戦略.md`「競合の観測」。multi-SNS-manager のトークンは方式が違い流用できない）
- **SNS原稿を作る：`/anniv-sns-batch`**（隔週13本＝X6・Threads6・予備1。JSONファイルを `記事管理/SNS原稿/` に出す → `anniv-tool.date/posts/inbox` でファイルを選んで取り込む → 人が1本ずつ承認 → 週3の枠へ自動で予約）
- **週1でPVを更新して読む：`/anniv-update-pv`**（D1の自前PV・GA4・Search Console → `KWマスターDB.csv` を再生成 → `現状ファクトシート.md` **だけ**を見て週次レポートを書く → `--publish` で `/admin/stats` に載せる。**デプロイ不要**。GA4・GSC はローカルに鍵が無いと飛ばす＝計測設計.md 11章「6.」）
- 記事を新規で書く：`/anniv-write-article <KW>`（H3が2個以上あるH2には要約カードが自動で入る）
- 既存記事をリライトする：`/anniv-rewrite-article <KW or ファイルパス>`
- 要約カードを単発で作る：`/anniv-card`（H2＋H3の本文を貼る）
- **記事を公開する**：`/anniv-write-article` は `article.md` を保存した時点で**下書きとして本番D1に入れる**（`scripts/put-draft.ts`）。出てきた `https://anniv.gift/admin/<id>/edit` を開き、slug を入力 → プレビューと公開前チェックを確認 → 公開。**リポジトリにMarkdownを置いても公開されない**（記事はD1にある）
  - 手で入れたいときは `/admin/new` の本文欄に `article.md` の全文（frontmatter込み）をそのまま貼れば同じ状態になる（frontmatter はメタ情報に自動で移る）
  - **slug は未設定のままでも下書き保存できる**（＝一時保存）。公開のときだけ必須
  - **スラッグは公開後に変えない**。日付も入れない（URL変更＋301欠落で検索評価がリセットされた実害が爆速開発部にある）
  - 公開したら `記事管理/KWマスターDB.csv` を最新化する。管理画面の「CSVエクスポート」で丸ごと上書きするか、`/anniv-update-pv` を回す（どちらも同じ列＝従来9列＋PV列。`src/lib/kw-csv.ts`）。手でURLを転記しない
  - **要約カードの画像は下書き投入と同時にR2へ上がり、本文も `![alt](/media/img/<key>)` に差し替わる**（`scripts/put-draft.ts`）。手で上げ直す必要はない。手で本文を貼った場合だけ、管理画面の「画像をアップロード」で差し替える（ローカルパスのままだと公開先で壊れる。公開前チェックが×で拾う）
  - 詳細な手順は `.claude/skills/anniv-write-article/SKILL.md` の Step 6-4／6-6
- ルール変更：文体・骨格・SEOなど全軸共通のルールは `.claude/agents/reference/article-style-guide.md` を編集。コンテンツ軸（テーマ・リサーチ観点・文体の寄せ）は `.claude/agents/reference/content-axis.md` を編集

**元の爆速開発部フローから未移植・簡略化した部分**（必要になったら元プロジェクト `C:\Users\sansh\OneDrive\爆速開発部\_config` を参照して移植する）：
- アフィリエイト運用（`記事管理/アフィリ案件マスター.csv` はヘッダーのみの雛形。Annivは現状Anniv送客CTAのみで、案件データは未投入。レストラン予約サイト等との提携を将来検討する可能性があり、始めるときはstyle-guide 19章の仕組みをStep 0のフォームに復元する）
- 公開後のローカルmd自動削除（`publish_article.py` 相当）。Annivでは `記事/[KW名]/article.md` をリライトの元原稿として残す運用にしたので移植していない

## 記事制作システムの運用メモ（実態に合わせた調整）

- **軸3（記念日代行・サプライズ代行サービス）の自己言及は実績控えめ**：Annivはまだ実績が少ない立ち上げ期のため、「手がけてきた」「多数の実績」のような実績の量・年数を暗示する表現は禁止（style-guide 2章）。実績が積み上がったら見直す。
- **記事を書く前のユーザー取材は必須**（2026-08-31にルール化）。新規は anniv-write-article Step 3.5、リライトは anniv-rewrite-article Step 1.5 で**必ず停止して質問し、回答をもらってから書く**。軸・ファネルによる例外は無く、**「今回は一般論で書けるから聞かない」という判断をこちら側でしてはいけない**（任意にすると聞かなくなり、どの記事にも本人の見解が入らなくなるため）。スキップできるのはユーザーが明示的にそう言ったときだけ。仕様は `.claude/agents/reference/interview-sheet.md`
  - 集め方は外部への「取材」ではなく**その場での自問自答**：実際にプレゼント選定・演出をプロデュースしているのはユーザー自身（小規模運営）なので、チャットで直接答えてもらう
  - 聞くのは事実だけでなく**運営者の意見・判断**（(d)分類）。相場・選び方のような一般論のテーマこそ、ここでしか読めない見解が差別化になる
  - 回答は**要約せず原文のまま** writer に渡す。公開前チェックリストと reviewer が「回答が本文に入っているか」を見る
  - 得た回答は `.claude/agents/reference/社内ナレッジ.md` に蓄積し、次回以降は同じことを聞かない
- **記事の公開先は `anniv.gift/media/` のサブディレクトリ**（サブドメインは不採用。根拠はメディア戦略.md 8章）。実装済み。記事はD1に置き、`/media/<slug>` でオンデマンドレンダリングする（公開ボタンから最長60秒で反映＝エッジキャッシュの `s-maxage=60`）。
- **記事の着手順は軸1→軸2→軸3**：軸3（受注直結）はKWがニッチで検索ボリュームが小さいため、軸1（検索ボリュームのある集客記事）で入口を作ってから内部リンクで軸3・無料相談に橋渡しする王道パターンにしている（メディア戦略.md 3章・7章）。
- **SEOはSNS運用と並行するチャネルの一つ**：CVへの主力は将来的にSNS（Instagram/X、有料広告含む）と想定しており、このリポジトリのSEO記事制作システムはその一部という位置づけ（メディア戦略.md 4章）。SNS運用自体はスコープ外。
