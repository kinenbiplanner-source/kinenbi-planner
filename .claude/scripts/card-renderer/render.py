"""Card renderer for Anniv media summary cards (ネイビー×ゴールドのブランドテーマ).

色は template.html の :root（src/styles/tokens.css と同じ値）が正。

Reads a JSON spec from stdin or a file path argument and writes a PNG.
The image is cards only — no title banner (the card grid IS the image).

JSON spec format:
{
  "items": [
    {"title": "10字以内", "caption": "15字以内...<hl>強調</hl>...", "icon": "plan"},
    ...
  ],
  "output": "C:/path/to/out.png",
  "cols":  3,            // optional: 2 or 3. auto if omitted
  "height": 404          // optional: in CSS px. auto if omitted
}

(A legacy "title" key is accepted but ignored.)

Usage:
  python render.py spec.json
  type spec.json | python render.py
"""
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


def find_chrome():
    """Locate Chrome/Chromium across Mac / Windows / Linux."""
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            candidates.append(p)
    for c in candidates:
        if Path(c).exists():
            return c
    return candidates[0]


HERE = Path(__file__).parent
CHROME = find_chrome()
TPL = (HERE / "template.html").read_text(encoding="utf-8")
ICONS = json.loads((HERE / "icons.json").read_text(encoding="utf-8"))

# --- layout constants (must match template.html) ---
STAGE_W   = 1200   # .stage width
PAD_V     = 52     # .stage top/bottom padding
CARD_H    = 300    # .card fixed height
GAP       = 28     # .grid gap between rows
SCALE     = 2      # device scale factor -> crisp 2x PNG output
NUM_VARIANTS = 4   # template.html の .stage.v0 .. .v{N-1} と一致させること（無地/点/縞/帯）

# --headless=new はウィンドウ枠ぶん(実測 mac で約87px)だけ実ビューポート(innerHeight)が
# window-size より小さくなる。そのため window-size をぴったり content 高さにすると、
# 下端 ~87px が描画されないまま撮影され、カード下辺・影・パディングが欠ける。
# 対策：window を content より十分高く撮って全部を確実に描画させ、撮影後に
# 既知の content 高さへ上から PNG をトリムする（OVERHEAD_PAD は枠ぶんの安全マージン）。
OVERHEAD_PAD = 200  # CSS px. mac実測87より十分大きく、Win/Linuxの枠差も吸収する


def auto_cols(n):
    if n <= 3:  return 3
    if n == 4:  return 2
    if n <= 6:  return 3
    return 3


def auto_height(n, cols):
    rows = (n + cols - 1) // cols
    # cards-only stage: top pad + rows + inter-row gaps + bottom pad
    return PAD_V + rows * CARD_H + (rows - 1) * GAP + PAD_V


def card_html(item):
    icon_key = item.get("icon", "info")
    svg = ICONS.get(icon_key, ICONS["info"])
    title = item["title"]
    # accept either <hl>...</hl> or <span class='hl'>...</span>
    caption = item["caption"].replace("<hl>", "<span class='hl'>").replace("</hl>", "</span>")
    return f"""
    <div class="card">
      <div class="icon">{svg}</div>
      <div class="card-title">{title}</div>
      <div class="card-cap">{caption}</div>
    </div>"""


def resolve_variant(spec):
    """背景バリアント(0..NUM_VARIANTS-1)を決める。
    - spec に "variant" があればそれを採用（範囲外は剰余で丸める）。
      同じ記事で複数枚作るときは呼び出し側で 0,1,2... と振れば柄が被らない。
    - 無ければ items の内容から決定的に選ぶ（指定し忘れ時の保険。
      同一内容は常に同じ柄になり、再生成しても揺れない）。"""
    v = spec.get("variant")
    if v is None:
        key = "".join(str(it.get("title", "")) + str(it.get("caption", ""))
                      for it in spec["items"])
        v = sum(ord(c) for c in key)
    return int(v) % NUM_VARIANTS


def build_html(spec):
    items = spec["items"]
    cols = spec.get("cols") or auto_cols(len(items))
    variant = resolve_variant(spec)
    cards = "".join(card_html(it) for it in items)
    body = f"""
    <div class="grid cols-{cols}">
      {cards}
    </div>"""
    html = TPL.replace("__CONTENT__", body).replace("__VARIANT__", f"v{variant}")
    return html, cols


def crop_png_top(path, keep_rows):
    """PNG を上から keep_rows 行だけ残してトリム（純標準ライブラリ・zlibのみ）.

    8bit・非インターレースの PNG が対象。フィルタ行を unfilter せずに先頭から
    連続した scanline ブロックだけ残すので（上方向参照は残すブロック内に収まる）
    再フィルタ不要。想定外フォーマットや keep_rows>=現高さ なら何もせず戻る
    （＝トリムしないだけで、画像自体は欠けていない）。"""
    try:
        data = Path(path).read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return
        pos = 8
        width = height = bitdepth = colortype = comp = filt = interlace = None
        idat = bytearray()
        ancillary = []  # IHDR/IDAT/IEND 以外を順序保持
        while pos < len(data):
            ln = struct.unpack(">I", data[pos:pos + 4])[0]
            ctype = data[pos + 4:pos + 8]
            cdata = data[pos + 8:pos + 8 + ln]
            pos += 12 + ln
            if ctype == b"IHDR":
                width, height, bitdepth, colortype, comp, filt, interlace = \
                    struct.unpack(">IIBBBBB", cdata)
            elif ctype == b"IDAT":
                idat += cdata
            elif ctype == b"IEND":
                break
            else:
                ancillary.append((ctype, cdata))
        if bitdepth != 8 or interlace != 0:
            return
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colortype)
        if channels is None or keep_rows >= height:
            return
        stride = 1 + width * channels
        raw = zlib.decompress(bytes(idat))
        new_raw = raw[:keep_rows * stride]
        new_idat = zlib.compress(new_raw, 9)

        def chunk(t, d):
            return (struct.pack(">I", len(d)) + t + d
                    + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff))

        out = b"\x89PNG\r\n\x1a\n"
        out += chunk(b"IHDR", struct.pack(">IIBBBBB", width, keep_rows,
                                          bitdepth, colortype, comp, filt, interlace))
        for t, d in ancillary:
            out += chunk(t, d)
        out += chunk(b"IDAT", new_idat)
        out += chunk(b"IEND", b"")
        Path(path).write_bytes(out)
    except Exception:
        return  # トリム失敗時は撮影画像をそのまま使う（下端が欠けるよりマシ）


def render(html, out_png, content_h):
    tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8")
    tmp.write(html)
    tmp.close()
    url = Path(tmp.name).as_uri()
    out_png = str(Path(out_png).resolve())
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    render_h = content_h + OVERHEAD_PAD  # 枠ぶんを足して content 全体を確実に描画させる
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
        "--default-background-color=00000000",
        f"--force-device-scale-factor={SCALE}",
        f"--window-size={STAGE_W},{render_h}",
        # レイアウト確定とWebフォント(Google Fonts)読み込みを待ってから撮影する。
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=5000",
        f"--screenshot={out_png}",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        sys.exit(r.returncode)
    # 撮影画像は (content_h + OVERHEAD_PAD) の高さで下に透明帯がある。
    # 既知の content 高さ（物理px = content_h * SCALE）へ上からトリムして密着させる。
    crop_png_top(out_png, content_h * SCALE)
    return out_png


def main():
    # Windowsの標準出力はロケール(cp932)なので、日本語を含む出力パスが化ける。UTF-8に固定する
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    if len(sys.argv) > 1:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        # Windows の標準入力はロケール(cp932)で解釈されるので、バイトで受けて
        # UTF-8 として自前でデコードする（日本語specがサロゲート化して落ちるのを防ぐ）
        spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))

    html, cols = build_html(spec)
    height = spec.get("height") or auto_height(len(spec["items"]), cols)
    out = render(html, spec["output"], height)
    print(out)


if __name__ == "__main__":
    main()
