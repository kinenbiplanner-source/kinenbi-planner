---
name: anniv-card
description: 見出し＋本文からAnnivブランドカラー（ネイビー×ゴールド）の要約カード画像を生成
argument-hint: <H2タイトル>と本文（H3を含む）をペースト
disable-model-invocation: true
---

# /anniv-card｜要約カード画像生成コマンド

ユーザーが貼った「H2タイトル＋H3を複数含む本文」を解析して、Annivメディアのブランドテンプレートで要約カードPNGを1枚生成する。

> 爆速開発部メディアの同名スキルをAnniv向けに移植。**レンダラーはこのリポジトリ内 `.claude/scripts/card-renderer/`（プロジェクト専用）**で、爆速開発部側（`~/.claude/scripts/card-renderer/`＝青りんご色）とは別物。色を変えるときは片方だけ直す。

## 色（ブランドカラー・変更するなら1か所）

配色は `.claude/scripts/card-renderer/template.html` の `:root` にあり、**値は `src/styles/tokens.css` と同じ**（ネイビー `#1a2840` ／ ゴールド `#c4a35a` ／ 淡いブルー `#f0f7fc`〜`#d6eaf8` ／ アイボリー `#fafaf8`）。

- 背景：淡いブルー〜アイボリーのグラデ＋ゴールドの光
- アイコンタイル：ブルー→ネイビーのグラデ
- カードタイトル：ネイビーの明朝（記事見出しと同じ `Noto Serif JP`）＋ゴールドの下線
- `<hl>` ハイライト：ゴールドの蛍光ペン

サイトのトークンを変えたら template.html の `:root` も合わせる（自動同期はしていない）。

## このコマンドの使い方

ユーザーは `/anniv-card` の後ろに、以下のような塊を貼る：

- マークダウン形式（`##` H2 + `###` H3 + 各段落）
- もしくは「タイトル：xxx」+ 箇条書き的な文章
- 完全なフリーテキストでもOK（その場合は要約段落自体をH3扱いで抽出）

## 自分（このコマンド）が必ず守るルール

1. **画像にタイトルは入れない**：画像はカードのみ。文字要素は「各カードタイトル」と「各カードの説明」の2種類だけ
2. **カードタイトルは10字以内**（厳守）
3. **カード説明は15字以内**（厳守。半角・全角・記号も1文字としてカウント）
4. **英語ラベルやセクション番号は入れない**（テンプレ側にもない）
5. **重要キーワードは `<hl>...</hl>` で囲む**（テンプレ側でゴールドの蛍光ペンに変換）
6. **`white-space: nowrap` 前提**なので、改行を避けるために短く詰める
7. **カードの文言も記事と同じ声で書く**（style-guide 8-0章）。煽り・ポエム・効能保証はカード内でもNG（「絶対喜ばれる」「一生の思い出」は使わない）。事実・判断軸を短く言い切る

## 作業フロー

### Step 1：保存先の確定（原則いつも記事フォルダの中）

**カードは必ずその記事のフォルダに一緒に置く**：`記事/[KW名]/images/`。記事とカードが離れると、リライトや再アップロードのときにどの画像がどの記事のものか分からなくなる。

- **記事が特定できるとき**（貼られた本文が `記事/[KW名]/article.md` のもの・KWが分かる・直前に扱っていた記事がある）→ `記事/[KW名]/images/` に置く。無ければ `images/` を作る。**ユーザーに聞かずにここへ置く**
- ユーザーが明示的にパスを指定していればそれを使う
- どの記事のものか本当に判断できないときだけ、対象の記事（KW）を1問だけ確認する。それでも分からなければ `記事/_未分類/images/` に置いて、どの記事のものか報告に書く

ファイル名は内容から英語スラッグを生成：`card_<連番>_<slug>.png` → 変換後 `.webp`（例：`card_01_budget.webp`）。連番はその記事の中でH2の登場順に振る。

### Step 2：内容の要約

ユーザーが貼った本文からカード化対象を抽出する：

- H3見出しがあればそれを各カードの起点に
- H3がない場合は段落の論点を抽出（最大6個まで）
- 各カードについて以下を埋める：
  - `title`：H3タイトルを10字以内に圧縮（例：「交際1年目の予算の決め方」→「予算」）
  - `caption`：本文の要旨を15字以内に詰める。一番効くキーワードを `<hl>...</hl>` で囲む（例：「20代は<hl>1万〜1.5万</hl>」）
  - `icon`：内容に合うアイコンキーを `.claude/scripts/card-renderer/icons.json` から選ぶ

### Step 3：JSON spec を組み立てる

形式（タイトルは無し。`items` と `output`＋任意で `variant`）：
```json
{
  "items": [
    {"title": "...", "caption": "...<hl>...</hl>...", "icon": "..."},
    {"title": "...", "caption": "...", "icon": "..."}
  ],
  "output": "C:/dev/kinenbi-planner/記事/[KW名]/images/card_01_xxx.png",
  "variant": 0
}
```

`variant` は背景パターン（0=無地 / 1=ドット / 2=縞 / 3=帯。色はすべてブランドカラー）。**未指定なら本文ハッシュから自動決定**。同じ記事で複数枚出すときは柄の衝突を避けるため `0,1,2,3` と明示して振る。

カード数とレイアウトの目安（高さはrender.pyが自動計算するので基本は指定しない）：

| カード数 | 列数 | 行数 | 画像高さ |
|---|---|---|---|
| 1〜3 | 3列 | 1行 | 404px |
| 4 | 2列 | 2行 | 732px |
| 5〜6 | 3列 | 2行 | 732px |
| 7〜9 | 3列 | 3行 | 1060px |

カード数は最大9枚まで。それ以上なら分割するか統合する。

### Step 4：レンダラー実行

**記事フォルダに spec.json を書かない。** spec は render.py の標準入力(stdin)に直接流し込む（ヒアドキュメント）。一時HTMLは render.py が内部で作って使うだけなので、こちらでファイルを残さない。成果物は `output` のPNG1枚だけ。

Bashツール（Git Bash）から実行する。Windowsなので `python3` ではなく **`python`**：

```bash
python .claude/scripts/card-renderer/render.py <<'JSON'
{ "items": [ {"title":"...","caption":"...<hl>...</hl>...","icon":"..."} ], "output": "C:/dev/kinenbi-planner/記事/[KW名]/images/card_01_xxx.png", "variant": 0 }
JSON
```

成功すると出力PNGの絶対パスがstdoutに出る（`output` で指定した場所に書かれる）。Chrome（ヘッドレス）で撮影するのでChromeが必要。

### Step 4-B：WebPに変換（必須）

render.py が出すPNGは2xスケールで **1枚500〜700KB**。そのままR2へ上げると記事1本で数MBになり、LCPが落ちてSEOで損をする。**必ずWebPに変換してから記事に入れる**（実測で約1/10、見た目の劣化はない）。

```bash
node .claude/scripts/card-renderer/to_webp.mjs "C:/dev/kinenbi-planner/記事/[KW名]/images/card_01_xxx.png"
```

変換すると元のPNGは削除され、`.webp` のパスがstdoutに出る（PNGも残したいときは `--keep`）。複数ファイルをまとめて渡せる。**記事に入れるのは `.webp` のほう**。

### Step 5：ユーザーに結果報告

- 生成した画像（WebP）の絶対パスをmarkdownリンクで提示
- JSON specの中身もコード fence で表示（後から微修正できるように）
- 文字数オーバーの恐れがある項目は警告

## アイコンの選び方

`icons.json` にあるキーから内容に合うものを選ぶ。**記念日ドメイン用に追加したもの**が上段：

| カテゴリ | キー |
|---|---|
| ギフト・プレゼント | gift / ring / flower / cake / heart |
| レストラン・デート | dinner / wine / pin / ticket |
| 日程・段取り | calendar / clock / plan / check |
| 演出・サプライズ | sparkle / camera / star / bulb |
| メッセージ・手紙 | mail / send / edit |
| 予算・費用 | cost（¥）/ yen / chart |
| 相手・二人 | group / heart |
| 注意点・失敗 | warn / limit / off / info |
| 依頼・サービス | doc / manage / gear / approve / shield |

該当なしの場合は `info` をデフォルト。新しいアイコンが必要になったら `icons.json` に追加すれば次回から使える（`stroke=currentColor` / `viewBox="0 0 24 24"` のストロークSVG）。

## 出力サンプル（H2「予算の決め方」＋H3三つ → spec）

```json
{
  "items": [
    {"title": "予算",     "caption": "20代は<hl>1万〜1.5万</hl>",   "icon": "cost"},
    {"title": "贈るもの", "caption": "形に残る<hl>アクセ</hl>が定番", "icon": "gift"},
    {"title": "渡し方",   "caption": "食事の<hl>デザート後</hl>",    "icon": "dinner"}
  ],
  "output": "C:/dev/kinenbi-planner/記事/彼女 誕生日プレゼント/images/card_01_budget.png",
  "variant": 0
}
```

## 記事に入れるとき（公開フロー）

生成したPNGは**ローカルの中間生成物**で、そのままでは公開サイトに出ない。記事はD1、画像はR2にあるため：

1. `article.md` には**ローカル相対パス**で入れておく：`![altテキスト](images/card_01_budget.webp)`（挿入位置は style-guide 9章「要約カード」）
2. 公開時（`/admin/new`）に本文を貼ったあと、**カード画像の行を選択して「画像をアップロード」ボタン**でPNGを上げ、挿入された `![alt](/media/img/<key>)` に差し替える
3. 公開前チェックで「ローカル画像パスが残っています」と出たら差し替え漏れ

## トラブルシュート

- **`white-space: nowrap` のせいで文字がはみ出す** → caption を15字以内に再圧縮（半角英数も1文字でカウント）
- **アイコンが内容と合わない** → `icons.json` から別キーを選び直す
- **日本語specで `UnicodeEncodeError`（サロゲート）** → stdinはUTF-8バイトで読む実装にしてある。それでも出るならspecをファイルに書いて `python render.py spec.json` で渡す
- **画像の下端（カード下辺・影・パディング）が切れる** → render.pyは対策済み。再発時は `OVERHEAD_PAD`（既定200）を増やす。テンプレ側の余白・カード高さ・gapを変えた時は render.py の同名定数も必ず合わせる
- **Chromeが見つからない** → render.py の `find_chrome()` の候補リストに自分の環境のパスを追加

## 関連ファイル

`.claude/scripts/card-renderer/`（このリポジトリ内）

- レンダラー：`render.py`／テンプレート：`template.html`／アイコン定義：`icons.json`／WebP変換：`to_webp.mjs`
- 補助：`card_extract.py`（記事mdからカード対象H2とH3を抽出）／`card_review.py`（生成カードをASCIIで確認・類似度で被り検出）

---

ユーザー入力：
$ARGUMENTS
