#!/usr/bin/env python3
"""Build the Kitestring brand SVGs from code (dev-only).

Geometry lives here so every asset is reproducible and exact. Outputs into brand/:
  mark.svg, mark-black.svg, mark-white.svg, mark-dark.svg, icon.svg,
  wordmark.svg, wordmark-dark.svg, lockup.svg, lockup-dark.svg, social-card.svg, tokens.json

The wordmark is Geist SemiBold (SIL OFL 1.1) converted to outlines; the i-dots are replaced by kite diamonds.
Needs fontTools and the Geist TTFs:
  python3 scripts/brand/build.py --font-dir /path/to/geist/ttf
(the directory must contain Geist-SemiBold.ttf and Geist-Regular.ttf).
Rasters (PNG icons, social card, test sheet) are produced by scripts/brand/export.sh.
"""
import argparse
import json
import math
import os

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BRAND = os.path.join(ROOT, "brand")

# ---- colour tokens -------------------------------------------------------------------------------------------
TOKENS = {
    "light": {"ink": "#16181D", "paper": "#FAF9F6", "accent": "#D63B1F", "accentInk": "#FFFFFF", "muted": "#5F646C"},
    "dark": {"ink": "#ECEDEF", "paper": "#141619", "accent": "#FF6B47", "accentInk": "#1A0904", "muted": "#9BA1AA"},
}
L, D = TOKENS["light"], TOKENS["dark"]


def f(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def poly(pts):
    return "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"


def clip(pts, a, b, c):
    """Sutherland-Hodgman against the half-plane a*x + b*y <= c."""
    out = []
    for i in range(len(pts)):
        p, q = pts[i], pts[(i + 1) % len(pts)]
        dp, dq = a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c
        if dp <= 0:
            out.append(p)
        if (dp < 0 < dq) or (dq < 0 < dp):
            t = dp / (dp - dq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


# ---- the mark: a K whose arm is a kite --------------------------------------------------------------------------
# Construction (256 grid, before centring):
#   stem   x 40..84, y 24..228 (44 wide)            -> the hand that holds the line
#   kite   tail on the stem edge at (84,140), axis exactly 45 deg up-right, length 168,
#          spar (widest point) at 64 % of the length, half-width 44 -> the agent, flying
#   leg    45 deg band, 46 wide horizontally, starts 16 below the kite tail -> keeps the K legible
STEM_X0, STEM_X1, TOP, BASE = 40, 84, 24, 228


SPAR_GAP = 10  # negative-space spar across the kite; dropped in the small-size cut


def mark_parts(small=False):
    stem = [(STEM_X0, TOP), (STEM_X1, TOP), (STEM_X1, BASE), (STEM_X0, BASE)]
    tail = (STEM_X1, 140)
    length, spar_at, hw = 168, 0.64, 44
    u = (math.sqrt(0.5), -math.sqrt(0.5))  # 45 deg up-right
    p = (math.sqrt(0.5), math.sqrt(0.5))   # perpendicular
    tip = (tail[0] + u[0] * length, tail[1] + u[1] * length)
    c = (tail[0] + u[0] * length * spar_at, tail[1] + u[1] * length * spar_at)
    whole = [tail, (c[0] + p[0] * hw, c[1] + p[1] * hw), tip, (c[0] - p[0] * hw, c[1] - p[1] * hw)]
    if small:
        kite = [whole]
    else:
        cu = c[0] * u[0] + c[1] * u[1]
        g = SPAR_GAP / 2
        kite = [clip(whole, u[0], u[1], cu - g),          # sail below the spar: (P - c).u <= -g
                clip(whole, -u[0], -u[1], -(cu + g))]     # nose above the spar:  (P - c).u >= g
    # leg: band between y - x = k0 and y - x = k0 + 46, from the stem edge, below y = 156, down to the baseline
    leg_top = 162 if small else 156  # wider kite/leg gap in the small cut so it stays open at 16 px
    k0 = leg_top - 118
    leg = [(STEM_X1, leg_top), (400, leg_top), (400, BASE), (STEM_X1, BASE)]
    leg = clip(leg, 1, -1, -k0)          # y - x >= k0       (below the upper-right edge)
    leg = clip(leg, -1, 1, k0 + 46)      # y - x <= k0 + 46  (above the lower-left edge)
    return stem, kite, leg


def kite_d(kite):
    return " ".join(poly(k) for k in kite)


def bbox(polys):
    xs = [x for pl in polys for x, _ in pl]
    ys = [y for pl in polys for _, y in pl]
    return min(xs), min(ys), max(xs), max(ys)


def placed_mark(size=256, pad=0.0, optical=-2.0, small=False):
    """Mark parts centred in a size x size box (optical: nudge up in grid units)."""
    stem, kite, leg = mark_parts(small)
    x0, y0, x1, y1 = bbox([stem, leg] + kite)
    w, h = x1 - x0, y1 - y0
    s = (size * (1 - 2 * pad)) / max(w, h)
    ox = (size - w * s) / 2 - x0 * s
    oy = (size - h * s) / 2 - y0 * s + optical * s
    tr = lambda pl: [(x * s + ox, y * s + oy) for x, y in pl]  # noqa: E731
    return tr(stem), [tr(k) for k in kite], tr(leg)


def svg_doc(w, h, title, body, bg=None):
    rect = f'  <rect width="{w}" height="{h}" fill="{bg}"/>\n' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-labelledby="title">\n  <title id="title">{title}</title>\n{rect}{body}</svg>\n')


def mark_body(ink, accent, offset=(0, 0), scale=1.0, size=256, pad=0.0, small=False):
    stem, kite, leg = placed_mark(size, pad, small=small)
    t = lambda pl: [(x * scale + offset[0], y * scale + offset[1]) for x, y in pl]  # noqa: E731
    ground = poly(t(stem)) + " " + poly(t(leg))
    return (f'  <g id="symbol">\n'
            f'    <path id="hand" fill="{ink}" d="{ground}"/>\n'
            f'    <path id="kite" fill="{accent}" d="{kite_d([t(k) for k in kite])}"/>\n  </g>\n')


def snapped_mark(size, px, k_px, left_px, top_px):
    """Small-size cut placed on a px-by-px pixel grid: K is k_px pixels tall, stem starts on a pixel edge."""
    stem, kite, leg = mark_parts(small=True)
    unit = size / px
    s = k_px * unit / (BASE - TOP)
    ox, oy = left_px * unit - STEM_X0 * s, top_px * unit - TOP * s
    tr = lambda pl: [(x * s + ox, y * s + oy) for x, y in pl]  # noqa: E731
    return tr(stem), [tr(k) for k in kite], tr(leg)


def icon_body(tile, fg, size=256, small=True, grid=None):
    """Toolbar/app icon: mark in fg on a rounded-square tile. grid=16 gives the pixel-snapped 16 px cut."""
    r = size * 0.22
    tile_d = (f"M{f(r)} 0 H{f(size - r)} A{f(r)} {f(r)} 0 0 1 {size} {f(r)} V{f(size - r)} "
              f"A{f(r)} {f(r)} 0 0 1 {f(size - r)} {size} H{f(r)} A{f(r)} {f(r)} 0 0 1 0 {f(size - r)} "
              f"V{f(r)} A{f(r)} {f(r)} 0 0 1 {f(r)} 0 Z")
    if grid == 16:
        stem, kite, leg = snapped_mark(size, 16, 11, 4, 2.5)
    else:
        stem, kite, leg = placed_mark(size, pad=0.17, small=small)
    return (f'  <path id="tile" fill="{tile}" d="{tile_d}"/>\n'
            f'  <path id="symbol" fill="{fg}" d="{poly(stem)} {poly(leg)} {kite_d(kite)}"/>\n')


# ---- wordmark ----------------------------------------------------------------------------------------------------
class Font:
    def __init__(self, path):
        self.tt = TTFont(path)
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.upm = self.tt["head"].unitsPerEm
        self.snap_k = path.endswith("Geist-SemiBold.ttf")

    def glyph(self, ch):
        return self.cmap[ord(ch)]

    # Geist's k diagonals sit at ~47 deg; in the wordmark they are snapped to exactly 45 deg so the k
    # echoes the mark's 45 deg kite axis and leg (outline points in font units, Geist SemiBold).
    K_45 = [(70, 710), (198, 710), (198, 315), (417, 534), (575, 534), (366, 325), (582, 0), (438, 0),
            (280, 239), (198, 157), (198, 0), (70, 0)]

    def path(self, gname, x, y, s):
        pen = SVGPathPen(self.gs, ntos=lambda v: f(v))
        tp = TransformPen(pen, (s, 0, 0, -s, x, y))
        if gname == "k" and self.snap_k:
            tp.moveTo(self.K_45[0])
            for pt in self.K_45[1:]:
                tp.lineTo(pt)
            tp.closePath()
        else:
            self.gs[gname].draw(tp)
        return pen.getCommands()

    def bounds(self, gname):
        from fontTools.pens.boundsPen import BoundsPen
        bp = BoundsPen(self.gs)
        self.gs[gname].draw(bp)
        return bp.bounds


def diamond_geom(font):
    """Centre and half-diagonal (font units) of the kite-diamond that replaces the i tittle."""
    bx0, by0, bx1, by1 = font.bounds("uni0307")
    rec = RecordingPen()
    font.gs["i"].draw(rec)
    cdx, cdy = [c[1][1][4:] for c in rec.value if c[1][0] == "uni0307"][0]
    r = (bx1 - bx0) * 0.80  # half-diagonal: optically matches the round dot's weight
    return (bx0 + bx1) / 2 + cdx, (by0 + by1) / 2 + cdy + 14, r


def diamond_top(font):
    _, cy, r = diamond_geom(font)
    return cy + r * 1.18


def text_paths(font, text, x, baseline, size, tracking=0.0, diamond_i=False):
    """Return (ink path data, diamond path data, advance) for a line of text set in font."""
    s = size / font.upm
    ink, dots = [], []
    pen_x = x
    for ch in text:
        if ch == " ":
            pen_x += font.gs[font.glyph(" ")].width * s + tracking * size
            continue
        g = font.glyph(ch)
        if diamond_i and ch == "i":
            ink.append(font.path("dotlessi", pen_x, baseline, s))
            cx, cy, r = diamond_geom(font)
            pts = [(cx, cy + r * 1.18), (cx + r, cy), (cx, cy - r * 1.0), (cx - r, cy)]
            dots.append(poly([(pen_x + px * s, baseline - py * s) for px, py in pts]))
        else:
            ink.append(font.path(g, pen_x, baseline, s))
        pen_x += font.gs[g].width * s + tracking * size
    return " ".join(ink), " ".join(dots), pen_x - x - tracking * size


def wordmark(font, ink, accent, x=0, baseline=0, size=200):
    d_ink, d_dots, adv = text_paths(font, "kitestring", x, baseline, size, tracking=-0.02, diamond_i=True)
    body = (f'  <g id="wordmark">\n    <path fill="{ink}" d="{d_ink}"/>\n'
            f'    <path fill="{accent}" d="{d_dots}"/>\n  </g>\n')
    return body, adv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font-dir", required=True)
    a = ap.parse_args()
    semi = Font(os.path.join(a.font_dir, "Geist-SemiBold.ttf"))
    reg = Font(os.path.join(a.font_dir, "Geist-Regular.ttf"))
    out = {}

    # marks
    out["mark.svg"] = svg_doc(256, 256, "Kitestring", mark_body(L["ink"], L["accent"], pad=0.06))
    out["mark-dark.svg"] = svg_doc(256, 256, "Kitestring", mark_body(D["ink"], D["accent"], pad=0.06))
    out["mark-black.svg"] = svg_doc(256, 256, "Kitestring", mark_body("#000000", "#000000", pad=0.06))
    out["mark-white.svg"] = svg_doc(256, 256, "Kitestring", mark_body("#FFFFFF", "#FFFFFF", pad=0.06))
    out["mark-small.svg"] = svg_doc(256, 256, "Kitestring", mark_body(L["ink"], L["accent"], pad=0.02, small=True))
    out["icon.svg"] = svg_doc(256, 256, "Kitestring", icon_body(L["accent"], "#FFFFFF"))
    out["icon-16.svg"] = svg_doc(256, 256, "Kitestring", icon_body(L["accent"], "#FFFFFF", grid=16))

    # wordmark: x-height 0.534 em; size 200 -> ascender of k ~ 148 units. Baseline at 200 in a 256-high box.
    size, base = 200, 196
    kb = semi.bounds("k")
    asc = max(kb[3], diamond_top(semi)) * size / semi.upm
    wm_body, adv = wordmark(semi, L["ink"], L["accent"], x=8, baseline=base, size=size)
    gb = semi.bounds("g")
    desc = -gb[1] * size / semi.upm
    wm_h = math.ceil(asc + desc + 16)
    wm_w = math.ceil(adv + 16)
    shift = base - asc - 8
    out["wordmark.svg"] = svg_doc(wm_w, wm_h, "Kitestring", f'<g transform="translate(0 {f(-shift)})">\n{wm_body}</g>\n')
    wm_dark, _ = wordmark(semi, D["ink"], D["accent"], x=8, baseline=base, size=size)
    out["wordmark-dark.svg"] = svg_doc(wm_w, wm_h, "Kitestring", f'<g transform="translate(0 {f(-shift)})">\n{wm_dark}</g>\n')

    # lockup: mark at 256 tall (no padding), wordmark x-height optically matched; baselines align with mark base.
    def lockup(c):
        """Mark 256 tall; wordmark ascender = 60 % of the mark, ascender-to-baseline centred on the mark."""
        stem, kite, leg = placed_mark(256, pad=0.0, optical=0)
        asc_h = 0.54 * 256
        sz = asc_h / (kb[3] / semi.upm)
        wm, adv2 = wordmark(semi, c["ink"], c["accent"], x=0, baseline=0, size=sz)
        mx1 = bbox([stem, leg] + kite)[2]
        tx = mx1 + 0.30 * 256
        ty = 128 + asc_h / 2
        body = (f'  <g id="symbol">\n    <path fill="{c["ink"]}" d="{poly(stem)} {poly(leg)}"/>\n'
                f'    <path fill="{c["accent"]}" d="{kite_d(kite)}"/>\n  </g>\n'
                f'  <g transform="translate({f(tx)} {f(ty)})">\n{wm}  </g>\n')
        return svg_doc(math.ceil(tx + adv2), 256, "Kitestring", body)

    out["lockup.svg"] = lockup(L)
    out["lockup-dark.svg"] = lockup(D)

    # social card 1280x640
    W, H = 1280, 640
    mk = mark_body(L["ink"], L["accent"], offset=(112, 136), scale=1.0, size=256, pad=0.0)
    wm, adv3 = wordmark(semi, L["ink"], L["accent"], x=420, baseline=300, size=150)
    t1, _, _ = text_paths(reg, "The agent flies the kite. You hold the string.", 420, 384, 36, tracking=-0.01)
    t2, _, _ = text_paths(reg, "Let AI coding agents drive your real, logged-in Chrome.", 112, 548, 28)
    rule = f'  <rect x="112" y="500" width="1056" height="2" fill="{L["ink"]}" opacity="0.12"/>\n'
    body = (mk + wm + f'  <path fill="{L["ink"]}" d="{t1}"/>\n' + rule +
            f'  <path fill="{L["muted"]}" d="{t2}"/>\n')
    out["social-card.svg"] = svg_doc(W, H, "Kitestring social card", body, bg=L["paper"])

    os.makedirs(BRAND, exist_ok=True)
    for name, content in out.items():
        with open(os.path.join(BRAND, name), "w") as fh:
            fh.write(content)
    with open(os.path.join(BRAND, "tokens.json"), "w") as fh:
        json.dump(TOKENS, fh, indent=2)
        fh.write("\n")
    print("wrote", ", ".join(sorted(out)) + ", tokens.json")


if __name__ == "__main__":
    main()
