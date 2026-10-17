# Kitestring brand

<p><img src="lockup.svg" alt="Kitestring" width="420"></p>

**The agent flies the kite, you hold the string.** The mark is a **K whose arm is a kite**: the
vermilion kite (the agent) lifts away up and to the right at exactly 45°, and the ink stem (you) holds
it to the ground. A thin spar cut across the kite makes it read as a kite rather than a flag.

## Files

| File | Use |
|---|---|
| `mark.svg` | Primary symbol, two colours, for light backgrounds. 256×256. |
| `mark-dark.svg` | Same, dark-theme colours, for dark backgrounds. |
| `mark-small.svg` | Small-size cut (no spar, wider kite/leg gap). Use it at 32 px and below. |
| `mark-black.svg`, `mark-white.svg` | One-colour versions (print, embossing, single-ink, overlays). |
| `wordmark.svg`, `wordmark-dark.svg` | “kitestring” in Geist SemiBold outlines; the i-dots are kite diamonds, the k is snapped to 45°. |
| `lockup.svg`, `lockup-dark.svg` | Mark + wordmark, horizontal. The README header uses these. |
| `icon.svg` | Toolbar / app icon: white K on a vermilion rounded tile. Source for 32 px and larger. |
| `icon-16.svg` | Pixel-snapped 16 px cut of the icon (2 px stem on the pixel grid). |
| `icons/icon-{16,32,48,128,512}.png`, `icons/mark-512.png` | Raster exports. |
| `social-card.png` / `.svg` | GitHub social preview, 1280×640. |
| `tokens.json` | Colour tokens for the popup and side panel. |
| `test-sheet.png` | Toolbar test (16/32 px on light and dark Chrome toolbars, one-colour, reversed) plus the logo-design test sheet. |
| `concepts/` | Round-1 concepts and iterations, kept for the record (`concepts/concepts.png`). |

The extension uses `packages/extension/assets/icon.png` (= `icons/icon-512.png`; Plasmo resizes it to 128/64/48/32)
and `packages/extension/assets/icon16.png` (= `icons/icon-16.png`; Plasmo ships it as-is instead of downscaling).

Rebuild everything with `GEIST_DIR=/path/to/geist/ttf scripts/brand/export.sh` (geometry lives in
`scripts/brand/build.py`; needs python3 with fontTools and Pillow, the `logo-design` skill scripts and a local
Chrome for rendering).

## Colours

| Token | Light | Dark | Use |
|---|---|---|---|
| `ink` | `#16181D` | `#ECEDEF` | Text, the K stem and leg |
| `paper` | `#FAF9F6` | `#141619` | Backgrounds |
| `accent` | `#D63B1F` | `#FF6B47` | The kite; primary actions, live/active state |
| `accentInk` | `#FFFFFF` | `#1A0904` | Text and icons on `accent` |
| `muted` | `#5F646C` | `#9BA1AA` | Secondary text, borders at reduced opacity |

Contrast (WCAG): ink/paper 16.9 (light) and 15.5 (dark); muted/paper 5.7 and 7.0; accentInk/accent 4.7 and 6.9;
accent/paper 4.4 (light, so use it for large text, icons and fills, not body text) and 6.4 (dark).
RGB: vermilion `214 59 31`, ink `22 24 29`.

`tokens.json` is shaped as one object per theme with the same five keys:

```json
{ "light": { "ink": "…", "paper": "…", "accent": "…", "accentInk": "…", "muted": "…" },
  "dark":  { "ink": "…", "paper": "…", "accent": "…", "accentInk": "…", "muted": "…" } }
```

Pick the theme with `prefers-color-scheme` and expose the keys as CSS custom properties (e.g. `--ks-ink`).

## Clear space and minimum size

- **Clear space:** keep one **stem width** (the width of the K's vertical stroke, about 1/5 of the mark's height)
  free on every side of the mark and the lockup.
- **Minimum size:** mark 16 px (use `mark-small.svg` or `icon-16.svg` at 32 px and below); lockup 24 px tall
  on screen (about 115 px wide), 6 mm tall in print. Below that, use the mark alone.
- **Lockup proportions are fixed:** the wordmark's ascender is 54 % of the mark height, centred on it, with a gap of
  0.3 × the mark height. Don't re-space it by hand; use `lockup.svg`.

## Do

- Use `mark.svg` / `lockup.svg` on light backgrounds and the `-dark` versions on dark ones.
- Use the one-colour black or white version when only one ink is available, or on photos and on the vermilion itself.
- Use the tile icon (`icon.svg`, `icons/`) wherever the background is unknown (browser toolbar, app launcher):
  it holds up on both light and dark Chrome toolbars.

## Don't

- Don't put the two-colour mark on vermilion (the kite disappears) or on black (the stem disappears).
- Don't recolour the kite and stem with other colours, add gradients, shadows or outlines.
- Don't rotate, mirror, stretch or re-angle the kite; its 45° axis is the idea.
- Don't set “kitestring” in live text as a logo; use the outlined wordmark.
- Don't add AI sparkles, robots or cursor arrows to the mark.

## How we got here

Brief (fixed): Kitestring lets AI agents drive your real browser while you keep control. The mark must read at 16 px
on light and dark toolbars, work in one colour, and avoid generic AI sparkles and robots. Adjectives: in control,
light, precise, trustworthy, calm. Category clichés avoided: sparkles, robots, cursor arrows, browser windows,
terminal prompts, and the blue of most developer tools.

Three concepts (greyscale, `concepts/concepts.png`):

- **A · Tether** (pictorial): a faceted kite on a sagging string held by a round dot (the person). Tells the story
  most literally, but the string is a hairline at 16 px and the tilted kite turns into a blob. Three iterations
  (`a-`, `a2-`, `a3-tether`) didn't fix it.
- **B · K-kite** (letterform): a K whose upper arm is a kite. **Chosen.** It is the only concept that still reads at
  16 px (it's a K first), it is ownable (no other dev tool's K is a kite), and it keeps the idea: the kite flies
  from the stem that holds it. The spar cut and the 45° axis were added in refinement so it reads as a kite at
  large sizes, and the wordmark repeats the idea in its diamond i-dots.
- **C · Reel** (pictorial): a spool with a small kite on a line. Puts the human first, but the kite is too small
  to read and the ring alone reads as a generic “o”.

Type: Geist SemiBold by Vercel, SIL Open Font License 1.1 (allows logo use and outlining). Trademark clearance
has not been searched; do a professional search before registering the mark.
