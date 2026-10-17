#!/usr/bin/env python3
"""Compose brand/test-sheet.png (dev-only, called by export.sh).

Top: the Chrome-toolbar test — the shipped icon PNGs at 16 and 32 px on Chrome's light and dark toolbar colours,
at 1x and pixel-zoomed 8x, plus the one-colour and reversed small cut at 16 px.
Below: the first part of the logo-design skill's test sheet (side by side, one-colour, reversed, scale ladder,
pixel test, backgrounds, treatments) from brand/.test-sheet-full.png, which is then deleted.
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

B = os.path.abspath(sys.argv[1])
SKILL = os.path.join(os.environ.get("LOGO_SKILL", os.path.expanduser("~/.claude/skills/logo-design")), "scripts")
TOOLBARS = [("light toolbar", "#FFFFFF"), ("light (grey)", "#F1F3F4"), ("dark toolbar", "#35363A"), ("dark (black)", "#202124")]
Z = 8


def font(size):
    d = os.environ.get("GEIST_DIR", "")
    try:
        return ImageFont.truetype(os.path.join(d, "Geist-Regular.ttf"), size)
    except OSError:
        return ImageFont.load_default()


def render(svg, size):
    out = tempfile.mktemp(suffix=".png")
    subprocess.run([sys.executable, os.path.join(SKILL, "render_png.py"), svg, "-o", out, "--size", str(size)],
                   check=True, stdout=subprocess.DEVNULL)
    im = Image.open(out).convert("RGBA")
    os.remove(out)
    return im


def on(bg, im):
    t = Image.new("RGBA", im.size, bg)
    t.alpha_composite(im)
    return t


def main():
    rows = [("icon 16 px (icons/icon-16.png)", Image.open(os.path.join(B, "icons", "icon-16.png")).convert("RGBA")),
            ("icon 32 px (icons/icon-32.png)", Image.open(os.path.join(B, "icons", "icon-32.png")).convert("RGBA")),
            ("one-colour black, small cut, 16 px", render(os.path.join(B, "mark-black.svg"), 16)),
            ("reversed white, small cut, 16 px", render(os.path.join(B, "mark-white.svg"), 16))]
    # one-colour rows use the small cut drawn in one colour
    small = open(os.path.join(B, "mark-small.svg")).read()
    for i, colour in ((2, "#000000"), (3, "#FFFFFF")):
        tmp = tempfile.mktemp(suffix=".svg")
        with open(tmp, "w") as fh:
            fh.write(small.replace("#16181D", colour).replace("#D63B1F", colour))
        rows[i] = (rows[i][0], render(tmp, 16))
        os.remove(tmp)

    W = 1400
    cells = [im.height * Z + 24 for _, im in rows]
    H = 110 + sum(c + 30 for c in cells)
    sheet = Image.new("RGB", (W, H), "#FAF9F6")
    d = ImageDraw.Draw(sheet)
    d.text((24, 20), "Kitestring — Chrome toolbar test (1x and 8x nearest-neighbour)", fill="#16181D", font=font(28))
    for c, (label, _) in enumerate(TOOLBARS):
        d.text((300 + c * 270, 70), label, fill="#5F646C", font=font(16))
    y = 100
    for r, (label, im) in enumerate(rows):
        cell = cells[r]
        d.text((24, y + cell // 2 - 10), label, fill="#16181D", font=font(16))
        for c, (_, bg) in enumerate(TOOLBARS):
            x = 300 + c * 270
            panel = Image.new("RGB", (250, cell), bg)
            t = on(bg, im)
            panel.paste(t.convert("RGB"), (12, 12))
            z = t.resize((t.width * Z, t.height * Z), Image.NEAREST)
            panel.paste(z.convert("RGB"), (250 - z.width - 12, 12))
            sheet.paste(panel, (x, y))
        y += cell + 30

    full = os.path.join(B, ".test-sheet-full.png")
    if os.path.exists(full):
        sk = Image.open(full).convert("RGB")
        sk = sk.crop((0, 0, sk.width, min(sk.height, 3500)))
        out = Image.new("RGB", (W, sheet.height + sk.height), "#FAF9F6")
        out.paste(sheet, (0, 0))
        out.paste(sk, (0, sheet.height))
        sheet = out
        os.remove(full)
    sheet.save(os.path.join(B, "test-sheet.png"), optimize=True)
    print("wrote", os.path.join(B, "test-sheet.png"), sheet.size)


if __name__ == "__main__":
    main()
