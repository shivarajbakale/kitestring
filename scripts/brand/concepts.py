#!/usr/bin/env python3
"""Round-1 concept builder for the Kitestring mark (dev-only, kept for the record).

Writes brand/concepts/{a-tether,b-k-kite,c-reel}.svg — black on transparent, 256x256.
Usage: python3 scripts/brand/concepts.py
"""
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "brand", "concepts")


def f(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def poly(pts):
    return "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"


def rot(p, deg, origin=(0, 0)):
    a = math.radians(deg)
    x, y = p[0], p[1]
    return (x * math.cos(a) - y * math.sin(a) + origin[0], x * math.sin(a) + y * math.cos(a) + origin[1])


def clip(pts, a, b, c):
    """Sutherland-Hodgman: keep points with a*x + b*y <= c."""
    out = []
    n = len(pts)
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        dp, dq = a * p[0] + b * p[1] - c, a * q[0] + b * q[1] - c
        if dp <= 0:
            out.append(p)
        if (dp < 0 < dq) or (dq < 0 < dp):
            t = dp / (dp - dq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def kite_facets(top, half_w, bottom, gap):
    """Kite with spine on x=0 and spar on y=0, split into 4 facets with a gap."""
    T, R, B, L = (0, -top), (half_w, 0), (0, bottom), (-half_w, 0)
    O = (0, 0)
    g = gap / 2
    facets = []
    for tri, (sx, sy) in (((T, R, O), (1, -1)), ((R, B, O), (1, 1)), ((B, L, O), (-1, 1)), ((L, T, O), (-1, -1))):
        pts = list(tri)
        pts = clip(pts, -sx, 0, -g)  # sx*x >= g
        pts = clip(pts, 0, -sy, -g)  # sy*y >= g
        facets.append(pts)
    return facets


def arc_band(p0, p1, sag, width):
    """Band of constant width along a circular arc from p0 to p1 (sag>0 bulges right of p0->p1)."""
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    chord = math.hypot(dx, dy)
    r = (chord / 2) ** 2 / (2 * abs(sag)) + abs(sag) / 2
    nx, ny = -dy / chord, dx / chord  # left normal
    s = 1 if sag > 0 else -1
    # centre lies opposite the bulge
    d = r - abs(sag)
    cx, cy = mx + s * nx * d, my + s * ny * d
    ro, ri = r + width / 2, r - width / 2

    def on(rad, p):
        vx, vy = p[0] - cx, p[1] - cy
        L = math.hypot(vx, vy)
        return (cx + vx / L * rad, cy + vy / L * rad)

    a0o, a1o, a0i, a1i = on(ro, p0), on(ro, p1), on(ri, p0), on(ri, p1)
    sweep = 1 if sag < 0 else 0
    cap = width / 2
    return (f"M{f(a0o[0])} {f(a0o[1])} A{f(ro)} {f(ro)} 0 0 {sweep} {f(a1o[0])} {f(a1o[1])}"
            f" A{f(cap)} {f(cap)} 0 0 {sweep} {f(a1i[0])} {f(a1i[1])}"
            f" A{f(ri)} {f(ri)} 0 0 {1 - sweep} {f(a0i[0])} {f(a0i[1])} Z")


def circle(cx, cy, r):
    return (f"M{f(cx - r)} {f(cy)} A{f(r)} {f(r)} 0 1 0 {f(cx + r)} {f(cy)}"
            f" A{f(r)} {f(r)} 0 1 0 {f(cx - r)} {f(cy)} Z")


def svg(title, paths, w=256, h=256):
    body = "\n".join(f'  <path d="{d}"/>' for d in paths)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-labelledby="title">\n  <title id="title">{title}</title>\n'
            f'  <g fill="#111111">\n{body}\n  </g>\n</svg>\n')


def concept_a():
    tilt, origin = 35, (156, 100)
    facets = kite_facets(54, 50, 112, 10)
    paths = [poly([rot(p, tilt, origin) for p in fa]) for fa in facets]
    tail = rot((0, 100), tilt, origin)
    hand = (52, 214)
    paths.append(arc_band(tail, hand, -22, 18))
    paths.append(circle(hand[0], hand[1], 20))
    return svg("Kitestring concept A: tether", paths)


def concept_b():
    stem = [(44, 28), (84, 28), (84, 228), (44, 228)]
    base, tip = (84, 136), (216, 32)
    ax, ay = tip[0] - base[0], tip[1] - base[1]
    L = math.hypot(ax, ay)
    ux, uy = ax / L, ay / L
    px, py = -uy, ux
    cross = (base[0] + ux * L * 0.62, base[1] + uy * L * 0.62)
    hw = 40
    kite = [base, (cross[0] + px * hw, cross[1] + py * hw), tip, (cross[0] - px * hw, cross[1] - py * hw)]
    leg = [(84, 150), (118, 150), (220, 228), (176, 228)]
    return svg("Kitestring concept B: K-kite", [poly(stem), poly(kite), poly(leg)])


def concept_c():
    reel_c, ro, ri = (82, 178), 50, 22
    ring = circle(reel_c[0], reel_c[1], ro) + " " + circle(reel_c[0], reel_c[1], ri)
    facets = kite_facets(30, 30, 62, 0)
    kite = [poly([rot(p, 40, (196, 66)) for p in fa]) for fa in facets[:1]]
    k = [rot(p, 40, (196, 66)) for p in [(0, -30), (30, 0), (0, 62), (-30, 0)]]
    tail = rot((0, 56), 40, (196, 66))
    start = (reel_c[0] + ro * 0.62, reel_c[1] - ro * 0.78)
    band = arc_band(start, tail, -10, 14)
    return (svg("Kitestring concept C: reel", [band, poly(k)])
            .replace("  <g fill=\"#111111\">", f'  <g fill="#111111">\n  <path fill-rule="evenodd" d="{ring}"/>'))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (("a-tether", concept_a), ("b-k-kite", concept_b), ("c-reel", concept_c)):
        with open(os.path.join(OUT, f"{name}.svg"), "w") as fh:
            fh.write(fn())
    print("wrote", OUT)


def concept_a2(gap=14, solid=False):
    """v2: bigger kite, heavier string and hand, fills the canvas."""
    tilt, origin = 40, (150, 98)
    facets = kite_facets(62, 62, 118, 0 if solid else gap)
    if solid:
        paths = [poly([rot(p, tilt, origin) for p in [(0, -62), (62, 0), (0, 118), (-62, 0)]])]
    else:
        paths = [poly([rot(p, tilt, origin) for p in fa]) for fa in facets]
    tail = rot((0, 104), tilt, origin)
    hand = (50, 210)
    paths.append(arc_band(tail, hand, -18, 24))
    paths.append(circle(hand[0], hand[1], 28))
    return svg("Kitestring concept A2: tether", paths)


if __name__ == "__main__":
    for name, s in (("a2-tether", concept_a2()), ("a2-tether-solid", concept_a2(solid=True))):
        with open(os.path.join(OUT, f"{name}.svg"), "w") as fh:
            fh.write(s)


def concept_a3(gap=12, solid=False):
    """v3: kite on the exact 45deg diagonal, string sags to the holder's dot in the far corner."""
    tilt = 45
    top, hw, bot = 64, 60, 116
    tip_target = (226, 30)
    t = rot((0, -top), tilt)
    origin = (tip_target[0] - t[0], tip_target[1] - t[1])
    shape = [(0, -top), (hw, 0), (0, bot), (-hw, 0)]
    if solid:
        paths = [poly([rot(p, tilt, origin) for p in shape])]
    else:
        paths = [poly([rot(p, tilt, origin) for p in fa]) for fa in kite_facets(top, hw, bot, gap)]
    tail = rot((0, bot - 14), tilt, origin)
    hand = (48, 208)
    paths.append(arc_band(tail, hand, 16, 22))
    paths.append(circle(hand[0], hand[1], 26))
    return svg("Kitestring concept A3: tether", paths)


if __name__ == "__main__":
    for name, s in (("a3-tether", concept_a3()), ("a3-tether-solid", concept_a3(solid=True))):
        with open(os.path.join(OUT, f"{name}.svg"), "w") as fh:
            fh.write(s)
