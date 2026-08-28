#!/usr/bin/env python3
"""card_review.py — 生成した要約カードPNGをテキスト化して自己レビューするツール。

画像を直接見られない環境（Readで image/png がブロックされる等）でも、
「柄が被っていないか」「レイアウトが崩れていないか」を判断できるように、
PNG を次のテキストに変換する:

  1) 明度量子化ASCIIアート ...... 背景の柄・全体構図が形として読める
     （ストライプ＝斜め縞、ドット＝点、グリッド＝格子、ブロブ＝塊 が見える）
  2) 定量指標 .................... 平均色・主要パレット・パターン密度
  3) 類似度マトリクス ............ どの2枚が似すぎか＝柄被りを自動検出

依存は Pillow のみ（numpy不要）。

使い方:
  python card_review.py a.png b.png ...
  python card_review.py path/to/images/*.png
"""
import sys
from pathlib import Path

from PIL import Image, ImageFilter

RAMP = " .:-=+*#%@"          # 明るい→暗い
BG_COLS = 72                 # ASCIIアートの横文字数
SIM_WARN = 0.85              # この類似度を超えたら「似すぎ」警告


def load_rgb(path):
    """RGBAを白背景に合成してRGBで返す（カードの透過・影を白地で正しく評価）。"""
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    return Image.alpha_composite(bg, im).convert("RGB")


def hexc(rgb):
    return "#%02X%02X%02X" % (rgb[0], rgb[1], rgb[2])


def avg_color(im):
    return hexc(im.resize((1, 1), Image.BILINEAR).getpixel((0, 0)))


def palette(im, n=6):
    """占有率つきの主要色（多い順）。"""
    q = im.quantize(colors=n, method=Image.FASTOCTREE)
    pal = q.getpalette()
    counts = q.getcolors() or []
    total = sum(c for c, _ in counts) or 1
    out = []
    for c, i in sorted(counts, reverse=True):
        rgb = tuple(pal[i * 3:i * 3 + 3])
        out.append((hexc(rgb), c / total))
    return out


def ascii_art(im, cols=BG_COLS):
    """明度を記号にマップした全体アート。柄・カード配置が形で読める。"""
    w, h = im.size
    rows = max(1, int(cols * (h / w) * 0.5))  # 文字セルは縦長なので0.5補正
    small = im.resize((cols, rows), Image.BILINEAR).convert("L")
    px = small.load()
    lines = []
    for y in range(rows):
        line = []
        for x in range(cols):
            v = px[x, y]
            idx = int((255 - v) / 255 * (len(RAMP) - 1))
            line.append(RAMP[idx])
        lines.append("".join(line))
    return lines


def pattern_density(im):
    """背景の柄の強さ。エッジ画像の平均輝度を 0..1 で返す。
    グラデ主体=低い / 縞・点・格子=高い。"""
    g = im.resize((200, 112), Image.BILINEAR).convert("L")
    edges = g.filter(ImageFilter.FIND_EDGES)
    data = list(edges.getdata())
    return sum(data) / len(data) / 255


def bg_signature(im):
    """背景の柄の指紋ベクトル。カード領域（明るい白）を除外し、
    背景だけのエッジ配置を 48x27 で取り、平均0正規化して返す。
    → 同じカード構成でも背景の柄が違えば距離が出る。"""
    w, h = 48, 27
    small = im.resize((w, h), Image.BILINEAR)
    lum = small.convert("L")
    edges = lum.filter(ImageFilter.FIND_EDGES)
    lpx = lum.load()
    epx = edges.load()
    vec = []
    for y in range(h):
        for x in range(w):
            # カード面（白っぽく非常に明るい）はマスク＝0
            vec.append(0.0 if lpx[x, y] > 205 else float(epx[x, y]))
    m = sum(vec) / len(vec)
    return [v - m for v in vec]


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def short(name):
    return Path(name).stem[-4:]


def main():
    # Windowsの標準出力はロケール(cp932)。日本語が文字化けするのでUTF-8に固定する
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    paths = [p for p in sys.argv[1:] if Path(p).exists()]
    if not paths:
        print("usage: card_review.py <png> [<png> ...]")
        return
    sigs = {}
    for p in sorted(paths):
        im = load_rgb(p)
        name = Path(p).name
        print(f"\n===== {name}  ({im.size[0]}x{im.size[1]}) =====")
        print(f"avg={avg_color(im)}   pattern_density={pattern_density(im):.3f}")
        print("palette: " + "  ".join(f"{h}({r*100:.0f}%)" for h, r in palette(im)))
        for ln in ascii_art(im):
            print("  " + ln)
        sigs[name] = bg_signature(im)

    names = list(sigs)
    if len(names) > 1:
        print("\n===== 背景の柄の類似度 (cosine; 1.00=そっくり) =====")
        print("      " + " ".join(f"{short(n):>5}" for n in names))
        warn = []
        for a in names:
            row = [f"{short(a):>5}"]
            for b in names:
                c = cosine(sigs[a], sigs[b])
                row.append(f"{c:5.2f}")
                if a < b and c > SIM_WARN:
                    warn.append((a, b, c))
            print(" ".join(row))
        if warn:
            print(f"\nWARN 柄が似すぎ (cos>{SIM_WARN}):")
            for a, b, c in sorted(warn, key=lambda t: -t[2]):
                print(f"  {a} vs {b}: {c:.2f}")
        else:
            print(f"\nOK: 全ペア cos<={SIM_WARN}（柄は十分バラけている）")


if __name__ == "__main__":
    main()
