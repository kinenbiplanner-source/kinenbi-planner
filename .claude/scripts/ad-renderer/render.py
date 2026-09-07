"""Ad creative renderer for Anniv (Instagram / Meta 広告用の紺×金カード).

書体は LP・メディアと同じ Noto Serif JP / Noto Sans JP、色は
src/styles/tokens.css の :root が正（実体は template.html の :root）。
AI画像生成だと特定フォントの字形が再現されないので、文字はここで描く。

JSON spec:
{
  "size": "feed" | "story" | "reel" | "square",
  "heading": ["記念日に何をしたらいいか", "悩んでいませんか？"],
  "bullets": ["ネットで調べても、パートナーに合うか分からない", ...],
  "closing": ["プレゼントからお店の予約、当日の演出まで。", "まとめてご相談いただけます。"],
  "logo":      true,          // optional (default true) 右下に logo_trans.png
  "body_sans": false,         // optional 箇条書き・締めをゴシック(Noto Sans JP)にする
  "block_w":   "76%",         // optional 箇条書き・締めのブロック幅
  "output": "C:/path/out.png"
}

サイズと安全域（template.html の CSS と対応）:
  feed   1080x1350  UIの被りなし。上下8%だけ空けて全面を使う
  story  1080x1920  上13%/下18%にIGのUI（プロフィール名・CTAボタン）が乗る
  reel   1080x1920  下35%までUI（いいね・キャプション・音源名）が乗る
  square 1080x1080  カルーセル用

Usage:
  python render.py spec.json
  type spec.json | python render.py
"""
import html as _html
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parents[2]                      # .claude/scripts/ad-renderer -> repo root
TPL = (HERE / "template.html").read_text(encoding="utf-8")
LOGO = REPO / "public" / "assets" / "logo_trans.png"

# PNGトリムとChrome探索は card-renderer の実装をそのまま使う（重複を持たない）
_spec = importlib.util.spec_from_file_location(
    "_anniv_card_renderer", HERE.parent / "card-renderer" / "render.py")
_cr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cr)
crop_png_top = _cr.crop_png_top
CHROME = _cr.find_chrome()

SIZES = {          # key: (width, height)
    "feed":   (1080, 1350),
    "story":  (1080, 1920),
    "reel":   (1080, 1920),
    "square": (1080, 1080),
}

SCALE = 1          # 1080px の指定がそのまま出力ピクセルになる
OVERHEAD_PAD = 200 # headless のウィンドウ枠ぶん。撮影後に本来の高さへトリムする


def esc(s):
    return _html.escape(str(s), quote=False)


def build_html(spec):
    size = spec.get("size", "feed")
    if size not in SIZES:
        sys.exit(f"unknown size: {size} (feed / story / reel / square)")

    heading = "<br>".join(esc(x) for x in spec.get("heading", []))
    bullets = "".join(f"<li>{esc(x)}</li>" for x in spec.get("bullets", []))
    closing = "".join(f"<p>{esc(x)}</p>" for x in spec.get("closing", []))

    parts = []
    if heading:
        parts.append(f'<div class="heading">{heading}</div>')
    if bullets:
        parts.append(f'<div class="body"><ul>{bullets}</ul></div>')
    if closing:
        parts.append(f'<div class="closing">{closing}</div>')
    if spec.get("logo", True):
        if not LOGO.exists():
            sys.exit(f"logo not found: {LOGO}")
        parts.append(f'<div class="logo"><img src="{LOGO.as_uri()}" alt=""></div>')

    body = "\n  ".join(parts)
    block_w = spec.get("block_w", "76%")
    body = f'<div style="--block-w:{block_w}; display:contents">{body}</div>'

    out = (TPL.replace("__SIZE__", size)
              .replace("__SANS__", "sans" if spec.get("body_sans") else "")
              .replace("__CONTENT__", body))
    return out, SIZES[size]


def render(html_text, out_png, size_wh):
    w, h = size_wh
    tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False,
                                      mode="w", encoding="utf-8")
    tmp.write(html_text)
    tmp.close()
    out_png = str(Path(out_png).resolve())
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
        "--default-background-color=00000000",
        f"--force-device-scale-factor={SCALE}",
        f"--window-size={w},{h + OVERHEAD_PAD}",
        # レイアウト確定と Google Fonts の読み込みを待ってから撮影する
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=8000",
        f"--screenshot={out_png}",
        Path(tmp.name).as_uri(),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        sys.exit(r.returncode)
    crop_png_top(out_png, h * SCALE)
    return out_png


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    if len(sys.argv) > 1:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))

    html_text, size_wh = build_html(spec)
    print(render(html_text, spec["output"], size_wh))


if __name__ == "__main__":
    main()
