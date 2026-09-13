---
name: anniv-pick-keyword
description: 軸を指定してKW候補の洗い出し・需要の数字・SERP要塞度を集め、勝ち筋／保留／書かないに振り分けて次に書く1本を決め、D1のキーワード台帳に登録する
argument-hint: <軸名 or gift/date/concierge>（省略可。省略時は在庫の薄い軸を提案）
disable-model-invocation: true
---

# /anniv-pick-keyword｜キーワード選定

軸を受け取り、候補の洗い出し → 需要の数字 → SERP要塞度 → 判定 → D1登録 まで回して、
**次に書く1本が決まっている状態**で終わる。決まったKWは `/anniv-write-article <KW>` にそのまま渡せる。

```
scripts/seo/suggest.ts ──────────▶ 記事管理/KW候補/<日付>_<軸>.json（候補・需要スコア・既出・カニバリ）
                                          │
scripts/seo/volume.ts ───────────▶ 同じJSONに volume / kd / volumeSource を書き戻す（Ahrefs ＞ CSV ＞ GSC）
                                          │
serp-difficulty-scout ×5〜8（並列）─▶ 分類ごとの件数 ─▶ src/lib/seo/serp.ts で検算 ─▶ serpGrade / serpNote
                                          │
Claude が keyword-selection.md 6・7章を当てて verdict / funnel を書く ─▶ ユーザーが次の1本を選ぶ
                                          │
scripts/seo/add-keywords.ts ─────▶ D1 keywords（win / hold だけ）─▶ /anniv-write-article <KW>
```

**選定の仕事は「書かない」を先に出すこと**。勝てないKWを書いてから診断で気づくのでは遅い（keyword-selection.md 6章）。

## メディア概要

- Anniv（`https://anniv.gift`）。メインターゲットは恋人・交際中カップル。CVは無料相談（`/apply`）
- コンテンツ軸：`.claude/agents/reference/content-axis.md` の「軸一覧」が正本（スラッグは `src/lib/axis.ts`）。**軸名をこのファイルに列挙しない**
- 判定基準：`.claude/agents/reference/keyword-selection.md`（SSOT）。5観点・要塞度A/B/C・ファネル層・需要の数字の優先・除外・優先順位はすべてここ。**このファイルには転記しない**
- 着手順は軸1→軸2→軸3（`メディア方針/メディア戦略.md` 3・7章）。軸3はSERPがほぼ空白なので需要の裏取りを必ず添える

## このコマンドの役割

**自分で実行：Step 0 / 1 / 2 / 3 / 5 / 6**（対話・スクリプト実行・判定・候補JSONの編集・D1登録）
**委譲：Step 4（serp-difficulty-scout。候補ごとに並列起動）**

ユーザーへの停止点は **Step 0（引数が無いときだけ）** と **Step 5（次の1本の決定）** の2つ。
Step 3（需要の数字）は**止まらない**。Ahrefs・CSV があれば使い、無ければ需要スコアだけで進む。
それ以外は内部処理で連結し、途中経過を逐一表示しない。

## 中間成果物（候補JSON）

`記事管理/KW候補/<YYYY-MM-DD>_<axis>.json`。形は `src/lib/seo/types.ts` の `KwCandidateFile`（`candidates[]` が `KwCandidate`）。誰がどの列を書くかが決まっている：

| 列 | 書く人 | いつ |
|---|---|---|
| `keyword` `seed` `axis` `demand` `known` `cannibal` `hits` | `suggest.ts` | Step 2 |
| `volume` `kd` `volumeSource` `gscImpr` | `volume.ts` | Step 3 |
| `serpGrade` `serpNote` | **Claude（Edit ツールで直接）** | Step 4 |
| `verdict` `funnel` `note` | **Claude（Edit ツールで直接）** | Step 2（drop）・Step 5 |

`add-keywords.ts` は `verdict` が `win` / `hold` の行だけを読んで D1 に入れる。**`funnel` が空だと止まる**。
Edit で書くときは `"keyword": "<KW>"` を含む一意な範囲を old_string にして、該当候補の空欄だけ差し替える。

## 作業フロー

### Step 0：軸の確定（自分で実行・引数があればスキップ）

引数が来ていれば（スラッグ・正式名・短縮名のどれでも。`src/lib/axis.ts` の `normalizeAxis` と同じ寄せ方）それで確定してフォームを出さない。

引数が無いときは在庫を数える。`/admin/keywords` は開かず、D1 を直接引く：

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute anniv --remote --json --command "SELECT axis, status, COUNT(*) n FROM keywords GROUP BY axis, status"
```

`content-axis.md`「軸一覧」の軸をそのまま選択肢にして AskUserQuestion を出す。各選択肢の description に「候補（todo）◯件／執筆中◯件／記事化済み◯件」を添え、**todo が少ない軸を先頭**に置く（keyword-selection.md 7章5＝在庫の薄い軸を優先）。

### Step 1：地勢の把握（自分で実行・停止しない）

この軸で「既に持っている面」と「狙わないと決めた領域」を確定する。

| 読むもの | 何のため |
|---|---|
| `.claude/agents/reference/keyword-selection.md` | 判定の全部。5観点・要塞度・ファネル層・需要の数字・除外・優先順位。**Step 4 で 2章を逐語コピーして scout に渡す** |
| `.claude/agents/reference/content-axis.md` の該当軸 | テーマ範囲（＝除外の境界）・想定読者・CV |
| `メディア方針/改良ロードマップ.md`「記事を書く」 | 勝てない領域・最大競合（anny.gift）・狙い目の領域 |
| `.claude/agents/reference/社内ナレッジ.md` の該当軸 | 一次情報で殴れる範囲。Step 4 で scout に渡す |
| `記事管理/PVレポート/現状ファクトシート.md` の「GSC クエリ」節 | 「取りこぼし」「striking distance」＝Step 5 ③のリライト候補。**台帳にも記事にも無いクエリ＝新KW候補**（「未カバーのクエリ」の節があればそこ、無ければ「表示上位」から自分で拾う） |
| 台帳の該当軸（D1） | 既存の `seed`（クラスタ）と公開済み・候補の一覧＝カニバリ判定の母集団と Step 2 の種KW |

台帳は SQL で引く（`<axis>` はスラッグ）：

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute anniv --remote --json --command "SELECT keyword, seed, funnel, status, priority, serp_grade FROM keywords WHERE axis='<axis>' ORDER BY seed, priority, id"
```

ファクトシートが古い／「GSC クエリ」節が無い（鍵が無くてスキップされた回）ときは、その旨を1行添えて先に進む（`/anniv-update-pv` を回さないと更新されない）。

### Step 2：候補の洗い出し（自分で実行・停止しない）

種KWは次の3つから組む。**3〜6語**：

1. 台帳の該当軸の `seed`（既存クラスタの補強＝7章1）
2. 改良ロードマップ「記事を書く」の狙い目領域（軸3の空白、「段取り・交渉・手続き」切り口など）
3. ファクトシートの未カバーのクエリ（GSC が既に露出を返している領域）

```bash
node --experimental-strip-types scripts/seo/suggest.ts --seeds "<種KW1>,<種KW2>" --axis <gift|date|concierge>
# 五十音＋a-z で全展開（重い）：                                --full
# 種KWそのままだけ叩く（速い）：                                --no-expand
# 出力先を変える（既定は 記事管理/KW候補/<日付>_<軸>.json）：   --out <path>
```

出てくるもの：候補JSON と、需要スコア降順の表。**既出（台帳・記事に同じKW）とカニバリ（dup / strong / weak）には印が付いている**。

受け取ったら除外ルールを当てて **20〜40語** に落とす：

- `keyword-selection.md` 5章（全体除外・非採用ジャンル）
- `content-axis.md` 該当軸の「テーマ範囲」の外側（その都度読んで当てる。転記しない）
- カニバリ `dup` は無条件で落とす。`strong` は切り口をずらせるかを Step 5 で見るのでここでは残す。`weak` は残す
- `known` が付いている行（既出）は落とす（台帳にあるなら再登録しない）

**落とした候補は候補JSONの `verdict` を `"drop"`、`note` に理由を1行で書いておく**（Edit で直接）。Step 5 の②「落としたKW」はここから作る。記憶に頼らない。

### Step 3：需要の数字（自分で実行・**停止しない**）

数字の出どころの優先は keyword-selection.md 4章（Ahrefs ＞ 手動CSV ＞ GSC表示数 ＞ 需要スコア）。上から順に試して、取れたものを使う。**ユーザーに CSV を置くよう頼んで待つことはしない**（置いてあれば使う。任意）。

**(a) Ahrefs MCP が繋がっているか確認する**

`ToolSearch` で `ahrefs` を検索する。名前に `ahrefs` を含み、キーワードの検索数・KD を返すツール（keywords explorer 系＝overview / volume / keyword ideas など。ツール名は接続してみないと分からない）があれば使う。

- MCP は登録済みでも**認証待ち**のことがある（セッション開始時の案内に「require authentication: ahrefs」と出る）。その状態ではツールが生えないので、ユーザーに「対話セッションで `/mcp` を開いて ahrefs を認証してから再実行」と1行伝えて、この回は (b) 以降で進める（待たない）

- units 節約のため、候補JSONの需要スコア**上位 20 件**に絞って叩く
- 結果を `記事管理/ボリューム/<YYYY-MM-DD>_ahrefs.json` に書く。形は `{"<keyword>": {"volume": 1200, "kd": 12}, ...}`
- 流す：

```bash
node --experimental-strip-types scripts/seo/volume.ts "記事管理/KW候補/<日付>_<軸>.json" --ahrefs "記事管理/ボリューム/<日付>_ahrefs.json" --gsc
```

**(b) Ahrefs が無ければ、`記事管理/ボリューム/` に CSV があるか見る**（キーワードプランナー／ラッコ。更新日時が最新のもの）

```bash
node --experimental-strip-types scripts/seo/volume.ts "記事管理/KW候補/<日付>_<軸>.json" --csv "記事管理/ボリューム/<file>.csv" --gsc
```

**(c) どちらも無ければ需要スコアだけで進む**

```bash
node --experimental-strip-types scripts/seo/volume.ts "記事管理/KW候補/<日付>_<軸>.json" --gsc
```

この場合、Step 5 の①の表の下に「**実数なし＝需要スコアの相対順のみ**」と明記する。需要スコアは候補どうしの順位でしかない（4章）。

**(d) `--gsc` は常に付ける**（GSC の鍵が無ければ黙って飛ぶ。既に露出している領域の表示数が `gscImpr` に入る）。

`volume.ts` は ahrefs ＞ csv ＞ gsc の順で上位のソースが勝つ。複数渡してもよい。

### Step 4：SERP要塞度（serp-difficulty-scout に委譲・並列）

対象は **5〜8本**。選び方：`verdict` が `drop` でない候補を、検索数があれば `volume` 降順、無ければ `demand` 降順に並べて上から取る。ユーザーが本数を指定していればそれに従う。

Agent ツールで `serp-difficulty-scout` を **1KWにつき1エージェント・1メッセージで並列**起動する。渡すもの：

- ターゲットKW（1つ）
- コンテンツ軸（スラッグと正式名）
- **`keyword-selection.md` 2章「SERP要塞度」をまるごと逐語コピー**（7分類の代表ドメイン表・A/B/Cの閾値の表・補正条件の箇条書き）。**要約・言い換えしない**
- **一次情報として書けること**：`社内ナレッジ.md` の該当軸セクション。無ければ「一次情報なし」と明示して渡す

受け取るもの：上位10のURL一覧（順位・URL・分類）／分類ごとの件数＋「機械検算用」の1行／要塞度 A/B/C＋根拠／鮮度／anny.gift が上位にいるか／予約DBの件数／検索意図／（軸3）検索意図のズレ／一次情報で殴れるか／推奨ファネル層／（A のとき）クエリをずらす案。

**受け取ったら件数をコードで検算する**（閾値の忖度を防ぐ）。scout の「機械検算用」の行の値をそのまま入れる：

```bash
node --experimental-strip-types -e "import('./src/lib/seo/serp.ts').then(m=>console.log(m.gradeFromCounts({counts:{ec:3,booking:1,affiliate:0,owned:2,official:0,personal:3,social:1,unknown:0},stale:false,hasAnny:true})))"
```

- scout の A/B/C とコードの結果が食い違ったら**コードの方を採る**（ルールの正は keyword-selection.md、コードはその写し。scout の判定は参考値）
- 分類そのものが怪しいときは URL 一覧を同じ要領で `gradeUrls` に通してドメイン表と突き合わせる（単社オウンド・公式は表に無いので `unknown` に落ちる。その分の件数がズレるのは正常）
- 10件取れていなければ `serpNote` に「n件で判定」を残す
- 軸3で「検索意図のズレ」が出た候補は要塞度に関わらず `drop` 側（Step 5 の②に理由付きで出す）

結果を候補JSONに Edit で書き込む：`serpGrade` にコードの A/B/C、`serpNote` に「上位10の内訳＋根拠＋補正＋anny の有無＋（軸3）意図のズレ」を1〜2行。

**各エージェントの生出力は表示しない**（Step 5 の表に統合する）。

### Step 5：判定と次の1本（ユーザー対話・必ず止まる）

`keyword-selection.md` の 6章（判定の出し方）と 7章（優先順位）を当てて、3つを**別枠で**出す。

**① 勝ち筋・保留**（勝ち筋 → 保留の順。7章の順で並べる）

| KW | 需要スコア | 検索数（ソース） | KD | 要塞度 | ドメイン適合 | CV距離 | カニバリ | 判定 |
|---|---|---|---|---|---|---|---|---|

- 検索数・KD が無い列は「—」。実数が1つも無いときは表の下に「**実数なし＝需要スコアの相対順のみ**」と1行
- **勝ち筋の上位 2〜3 本には `links.ts --kw` を回し、「既存記事のどこから張れるか」を1行添える**（受け皿がある KW は立ち上がりが早い＝7章1）：

```bash
node --experimental-strip-types scripts/seo/links.ts --kw "<KW>" --axis <axis>
```

- anny.gift が上位にいる KW は「実務ディテールで勝てるか」を1行添える（2章の補正）
- 軸3の勝ち筋には需要の裏取り（4章の1〜3か `gscImpr`）を必ず添える（7章2）

**② 落としたKW（書かない判定）** — 理由を1行ずつ。Step 2 で `drop` にしたもの＋Step 4 で要塞度A かつ一次情報で殴れないもの＋検索意図がズレたもの。**この枠を省略しない**（落としたことを見せるのがこのコマンドの仕事）。

**③ リライト候補（新規より ROI が高い可能性）** — ファクトシートの「取りこぼし」「striking distance」を既存記事に紐づけて並べる（表示・CTR・順位付き）。GSC が取れていない回は「GSC なし」と1行。

そのうえで候補JSONに Edit で書き込む：

- `verdict`：`win` / `hold` / `drop`
- `funnel`：keyword-selection.md 3章の語尾パターンで割り当てる（迷ったら検索意図を優先）。**win / hold は必ず埋める**（空だと Step 6 が止まる）
- `note`：hold は保留理由（ずらし案があればそれも）、win は差別化の芯を1行

**AskUserQuestion で「次に書く1本」を選ばせる**。選択肢は勝ち筋の推奨を先頭に、③のリライト候補も入れる。推奨の理由は description に1行。

Ahrefs が繋がっていなかった回は、この表示の末尾に1行だけ添える（毎回しつこく言わない）：

> Ahrefs（Lite ¥19,900/月）を繋げば実数と KD が自動で入る。`claude mcp add ahrefs https://api.ahrefs.com/mcp/mcp -t http`

### Step 6：D1登録と引き継ぎ（自分で実行・停止しない）

**採用しなかった候補も含めて** `win` / `hold` を D1 に入れる（次回の再調査を消すため）。`drop` は入れない。

```bash
node --experimental-strip-types scripts/seo/add-keywords.ts "記事管理/KW候補/<日付>_<軸>.json" --dry-run
```

dry-run の表は**ユーザーに見せず**、自分で確認する：入るのが win / hold だけか／funnel が全部埋まっているか／既出がスキップになっているか。問題なければ本実行：

```bash
node --experimental-strip-types scripts/seo/add-keywords.ts "記事管理/KW候補/<日付>_<軸>.json"
```

出力（追加・スキップ）は**そのまま見せる**。

**台帳の CSV（`記事管理/KWマスターDB.csv`）は手で書かない**。D1 から吐き出す派生物なので、`/anniv-update-pv` か管理画面の CSV エクスポートで更新される。

最後に、選ばれたものに応じて次のコマンドを提示する：

- 新規KW → `/anniv-write-article <KW>`
- リライト → `/anniv-rewrite-article <KW>`

## 注意事項

- **需要スコアは絶対量ではない**。候補20個の中で上から何番目か、にしか使わない。サジェストに出る＝検索されている、ではあるが件数は分からない（4章）。実数が取れないときは Step 5 に明記し、需要が確認できない KW を勝ち筋にしない
- **要塞度Aを忖度してBに倒さない**。閾値は `serp.ts` に固定してあり、scout と食い違ったらコードを採る。「ギフト おすすめ」系に正面から入って EC に沈むのを防ぐのがこの関門
- **数字を第1基準にしない**。優先順位はクラスタ補強 → CV距離 → 要塞度 C＞B → 需要 → 軸の在庫（7章）。需要は同点のタイブレーク
- **台帳の SEO 列（`seed` `volume_num` `volume_source` `demand_score` `kd` `serp_grade` `serp_note` `researched_at`）はこのコマンドと `/admin/keywords/<id>` の編集画面だけが書く。`/anniv-update-pv` は触らない**
- 各サブエージェントは独立 context で動く。7分類の表・判定基準・一次情報の範囲は**全部プロンプトに含めて**渡す（scout は外部ファイルを読まない）
- 候補JSONは作業ファイル。D1 に入った時点で役目は終わりだが消さない（次回「なぜ落としたか」を見返す材料）
- ルールを変えるときは `keyword-selection.md` と `src/lib/seo/serp.ts` の**両方**を直す（片方だけだと scout とコードの検算がズレる）

## ルールの所在（SSOT）

- `.claude/agents/reference/keyword-selection.md` — **KW選定の判定基準SSOT**（5観点・要塞度・ファネル層・需要の数字・除外・優先順位）
- `.claude/agents/reference/content-axis.md` — 軸定義SSOT（軸一覧・テーマ範囲・想定読者・CV先）
- `メディア方針/改良ロードマップ.md`「記事を書く」／`メディア方針/メディア戦略.md` 3・7章 — 勝てない領域・最大競合・着手順
- `.claude/agents/reference/社内ナレッジ.md` — 一次情報として書ける範囲
- `.claude/agents/serp-difficulty-scout.md` — Step 4（自己完結。外部ファイルは読まない）
- `src/lib/seo/serp.ts`（要塞度）／`cannibal.ts`（カニバリ）／`demand.ts`（需要スコア）／`internal-links.ts`（内部リンク）— 機械判定の実装。型は `types.ts`
- `scripts/seo/suggest.ts` / `volume.ts` / `add-keywords.ts` / `links.ts` — CLI。D1 の経路は `scripts/seo/_d1.ts`（wrangler）
- KW台帳：D1 `keywords`（`/admin/keywords`。CSV は `記事管理/KWマスターDB.csv` に派生）
- `記事管理/PVレポート/現状ファクトシート.md` — GSC 実データ（`/anniv-update-pv` が再生成する）
