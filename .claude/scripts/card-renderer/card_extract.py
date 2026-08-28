#!/usr/bin/env python3
"""
記事Markdownを解析し、要約カード対象（H3を2個以上持つH2）を抽出して JSON で返す。
カード生成（anniv-write-article Step 6-2）の前処理。LLMが目視でH3を数える手間と数え間違いを無くす。

  python card_extract.py article.md
  cat article.md | python card_extract.py

出力（stdout, JSON）:
  [
    {"h2": "料金プラン", "h3_count": 3,
     "h3s": [{"heading": "無料プラン", "body": "..."}, ...]}
  ]
LLMはこの各H3を title(10字以内)/caption(15字以内,<hl>)/icon に圧縮して spec を組み、
render.py に流す（圧縮は意味理解が要るのでLLMが担当。抽出と数えはこのスクリプト）。

カウント規則:
  - 見出しは行頭の # の数で判定（## = H2 / ### = H3）。# と #### 以下は無視
  - コードフェンス(```)内・カスタムブロック(::: ... :::)内の ### は数えない
    （:::timeline 内の ### はカードのH3ではなく手順ステップのため）
  - frontmatter(先頭の --- ... ---)は読み飛ばす
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HEADING = re.compile(r"^(#+)\s+(.*\S)\s*$")
BODY_CAP = 200  # 各H3のbody抜粋の上限（圧縮はLLMがやるので文脈ぶんあれば十分）


def strip_frontmatter(lines: list[str]) -> list[str]:
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return lines[i + 1:]
    return lines


def extract(md: str) -> list[dict]:
    lines = strip_frontmatter(md.splitlines())
    h2_list: list[dict] = []
    cur_h2: dict | None = None
    cur_h3: dict | None = None
    in_code = False
    colon_depth = 0

    def flush_h3():
        nonlocal cur_h3
        if cur_h3 is not None and cur_h2 is not None:
            body = re.sub(r"\s+", " ", " ".join(cur_h3["_buf"]).strip())[:BODY_CAP]
            cur_h2["h3s"].append({"heading": cur_h3["heading"], "body": body})
        cur_h3 = None

    for line in lines:
        stripped = line.strip()

        # コードフェンスの開閉
        if stripped.startswith("```"):
            in_code = not in_code
            if cur_h3 is not None:
                cur_h3["_buf"].append(line)
            continue
        if in_code:
            if cur_h3 is not None:
                cur_h3["_buf"].append(line)
            continue

        # カスタムブロック ::: の開閉（:::word=開く / 単独::: =閉じる）
        if stripped.startswith(":::"):
            if stripped == ":::":
                colon_depth = max(0, colon_depth - 1)
            else:
                colon_depth += 1
            if cur_h3 is not None:
                cur_h3["_buf"].append(line)
            continue

        m = HEADING.match(line) if colon_depth == 0 else None
        level = len(m.group(1)) if m else 0

        if level == 2:
            flush_h3()
            if cur_h2 is not None:
                h2_list.append(cur_h2)
            cur_h2 = {"h2": m.group(2).strip(), "h3s": []}
        elif level == 3 and cur_h2 is not None:
            flush_h3()
            cur_h3 = {"heading": m.group(2).strip(), "_buf": []}
        else:
            if cur_h3 is not None:
                cur_h3["_buf"].append(line)

    flush_h3()
    if cur_h2 is not None:
        h2_list.append(cur_h2)

    # H3が2個以上のH2だけがカード対象
    out = []
    for h in h2_list:
        if len(h["h3s"]) >= 2:
            out.append({"h2": h["h2"], "h3_count": len(h["h3s"]), "h3s": h["h3s"]})
    return out


def main() -> None:
    # Windowsの標準出力はロケール(cp932)になり、JSONが読めない文字化けで出る。
    # 出力は常にUTF-8に固定する（stderrのサマリも同じ）。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    if len(sys.argv) > 1:
        md = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        # Windowsのstdinはcp932解釈になるのでバイトで受けてUTF-8デコードする
        md = sys.stdin.buffer.read().decode("utf-8")
    cards = extract(md)
    print(json.dumps(cards, ensure_ascii=False, indent=2))
    # 人間向けサマリは stderr（stdout はJSONのまま保つ）
    sys.stderr.write(f"\nカード対象H2: {len(cards)}個" +
                     ("".join(f"\n  - {c['h2']}（H3 {c['h3_count']}個）" for c in cards) or "（なし）") + "\n")


if __name__ == "__main__":
    main()
