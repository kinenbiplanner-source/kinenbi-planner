---
name: anniv-research
description: competitor-researcher を記事を書かずに単独で回し、KWの検索意図・上位の顔ぶれ・差別化の穴・一次情報で殴れるかを 記事管理/リサーチ/<KW>.md に残す。KW選定の裏取り・リライト前の再確認・リサーチマスターの先回り用
argument-hint: <KW>（任意で「メモ：〜」を続けられる）
disable-model-invocation: true
---

# /anniv-research｜競合リサーチだけを単独で回す

`competitor-researcher` を**記事を書かずに**起動し、結果をファイルに残して要約を返す。
`/anniv-write-article` の Step 1 と同じリサーチを、執筆から切り離して先に済ませるためのコマンド。

```
KW ──▶ Step 0 軸・ファネル ──▶ competitor-researcher（write-article Step 1 と同じ渡し方）
                                        │
                                        ├─▶ 記事管理/リサーチ/<KW>.md（生の出力をそのまま保存）
                                        ├─▶ 記事管理/リサーチマスター.md（更新提案を反映）
                                        └─▶ ユーザーへ10行以内の要約
```

## 使いどころ

| 場面 | 何を見るか |
|---|---|
| **KW選定の裏取り**（`/anniv-pick-keyword` の勝ち筋を書く前） | 「一次情報で殴れるか」「差別化の穴が本当にあるか」を執筆前に確かめる。scout（上位10の顔ぶれだけ）では見えない中身の差 |
| **リライト前** | 上位の顔ぶれが公開時から変わったか。新しく入ってきた競合が何を書いているか |
| **リサーチマスターの先回り** | 近く書く予定のジャンルの公式情報（料金・提供範囲）を鮮度付きで温めておく。次に `/anniv-write-article` を回すときの Step 1 が軽くなる |

## このコマンドの役割

**自分で実行：Step 0 / 2 / 3 / 4**（軸の確定・保存・リサーチマスター反映・要約）
**委譲：Step 1（competitor-researcher）**

停止点は **Step 0 で軸・ファネルが KW から判断できないときだけ**（AskUserQuestion を1回）。判断できれば最後まで止まらない。

## 作業フロー

### Step 0：軸・ファネルの確定（自分で実行）

`$ARGUMENTS` から KW と「メモ：〜」を分ける。

**台帳にある KW なら axis / funnel はそこから取る**：

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute anniv --remote --json --command "SELECT axis, funnel, seed, status, note FROM keywords WHERE keyword='<KW>'"
```

無ければ `/anniv-write-article` Step 0-A と同じやり方で決める：

- 軸：`.claude/agents/reference/content-axis.md`「軸一覧」から。KW から判断できればフォームを出さない
- ファネル層：`.claude/agents/reference/keyword-selection.md` 3章の語尾パターンで。迷うときだけ聞く
- どちらか迷うときだけ AskUserQuestion を1回（軸とファネルをまとめて選択式で）

用途は、メモに書いてあればそれ。無ければ台帳の `status` が `done` なら「リライト前」、それ以外は「選定の裏取り」とみなす（Step 2 の見出しに書くだけで、リサーチの中身は変えない）。

### Step 1：競合リサーチ（competitor-researcher に委譲）

Agent ツールで `competitor-researcher` を起動。**渡すものは `/anniv-write-article` Step 1 と同じ**：

- ターゲットKW
- **コンテンツ軸とそのリサーチ観点**：content-axis.md の該当軸の「リサーチ観点」を明記して渡す
- ファネル層（集客 / 比較・検討 / 課題解決）
- **ユーザーメモ（任意）**：「リサーチで確認・補強したい論点」として
- 用途が「リライト前」のときは、既存記事の slug と公開日を「既存記事の有無」として渡す（構造情報だけ。本文は渡さない）

**既知ファクトを断定的に含めない**（write-article Step 1 と同じ）。「◯◯の相場は3万円」のような事実は渡さない。渡すのは KW・軸とリサーチ観点・ファネル層・既存記事の有無の構造情報だけ。ユーザーメモは実体験なので渡してよい。

`記事管理/リサーチマスター.md` は researcher が自分で読む（確認日14日以内・Confidence高は再取得しない）。こちらから中身を渡さない。`社内ナレッジ.md` も渡さない（write-article でも researcher には渡していない。一次知見の照合は Step 4 でこちらがやる）。

受け取るもの：検索意図マップ／上位10記事の分析／共通トピック／抜けている情報／最新動向／公式情報（Confidence 付き）／差別化ポイント 3〜5／一次情報ソース／リサーチマスター更新提案。

### Step 2：保存（自分で実行）

`記事管理/リサーチ/<KW>.md` に**出力をそのまま**保存する（要約・整形しない。write-article の Step 1 で使い回すため）。
ファイル名の KW は、スペースと `/` `:` などファイル名に使えない記号を `_` に置き換える（`記事/[KW名]/` と同じ規則）。

先頭に4行だけ足す：

```
調査日: YYYY-MM-DD
軸: gift（記念日ギフト・サプライズ）
ファネル: 課題解決
起動: competitor-researcher（focus なし）／メモ: なし／用途: 選定の裏取り
```

**既にファイルがあれば上書きしない**。`<KW>_<YYYY-MM-DD>.md` で並べる（同日に2回目なら末尾に `_2`）。上位の顔ぶれの変化を差分で見るため。

### Step 3：リサーチマスターの更新（自分で実行）

出力末尾の「リサーチマスター更新提案」を `記事管理/リサーチマスター.md` に反映する。手順は `/anniv-write-article` Step 1 の「Step 1後のリサーチマスター更新」と同じ：該当項目を追記／更新（確認日・Confidence・出典付き。ファイルが無ければ新規作成）。提案が「なし」なら何もしない。

### Step 4：要約（自分で実行）

**10行以内**で返す：

1. 検索意図マップ（顕在＋必ず答えるべき問いで1行、潜在で1行）
2. 差別化ポイント 3〜5（1行ずつ）
3. **一次情報で殴れるか**：`.claude/agents/reference/社内ナレッジ.md` の該当軸と上の差別化ポイントを照らして1行（殴れる／殴れない＋根拠）。ナレッジが無い軸は「一次情報なし」
4. 要塞度の所感：上位10の顔ぶれ（EC・予約DB・まとめが何件か、anny.gift がいるか）から1行。**正式な A/B/C は `/anniv-pick-keyword` の scout＋`src/lib/seo/serp.ts` で出す**ので、ここでは所感に留める
5. 保存先のパス

最後に添える：

> このまま書くなら `/anniv-write-article <KW>`。Step 1 は `記事管理/リサーチ/<KW>.md` があれば再リサーチを省ける（同日中なら）

## やらないこと

- **記事は書かない。見出し案も出さない**（それは `/anniv-write-article` の Step 2 以降の仕事）
- ユーザー取材（write-article Step 3.5）はしない。一次知見の有無は `社内ナレッジ.md` を読んで判定するだけ
- リサーチファイルを D1 に入れない（ローカルの作業ファイル。`put-draft.ts` に渡さない）
- `serp-difficulty-scout` は起動しない（要塞度の正式判定は `/anniv-pick-keyword`）
- 既存のリサーチファイルを上書きしない（差分を見るため）
- researcher の出力を要約して保存しない（要約はチャットに返すぶんだけ。ファイルは原文）

## 関連

- `.claude/agents/competitor-researcher.md` — 起動する相手。受け取るもの・返すものはここが正
- `.claude/skills/anniv-write-article/SKILL.md` Step 1 — 渡し方の本体（ここと同じにする）
- `.claude/skills/anniv-pick-keyword/SKILL.md` — 要塞度の正式判定と台帳登録
- `記事管理/リサーチマスター.md` — 公式情報の鮮度付きキャッシュ（researcher が読み、このコマンドが書き戻す）
