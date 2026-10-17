#!/usr/bin/env bash
# Rasterise the Kitestring brand (dev-only). Needs: python3 + fontTools + Pillow, the logo-design skill's
# scripts (LOGO_SKILL, default ~/.claude/skills/logo-design) and a local Chrome/Chromium for rendering.
#   GEIST_DIR=/path/to/geist/ttf scripts/brand/export.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL="${LOGO_SKILL:-$HOME/.claude/skills/logo-design}/scripts"
B="$ROOT/brand"

python3 "$ROOT/scripts/brand/build.py" --font-dir "${GEIST_DIR:?set GEIST_DIR to a folder with Geist-SemiBold.ttf and Geist-Regular.ttf}"

mkdir -p "$B/icons"
# 16 px comes from the pixel-snapped small cut; everything larger from the regular icon.
python3 "$SKILL/render_png.py" "$B/icon-16.svg" -o "$B/icons/icon-16.png" --size 16
for s in 32 48 128 512; do
  python3 "$SKILL/render_png.py" "$B/icon.svg" -o "$B/icons/icon-$s.png" --size "$s"
done
python3 "$SKILL/render_png.py" "$B/mark.svg" -o "$B/icons/mark-512.png" --size 512
python3 "$SKILL/render_png.py" "$B/social-card.svg" -o "$B/social-card.png" --width 1280 --height 640

# Extension: Plasmo resizes assets/icon.png for every size, but uses assets/icon16.png verbatim when present.
cp "$B/icons/icon-512.png" "$ROOT/packages/extension/assets/icon.png"
cp "$B/icons/icon-16.png" "$ROOT/packages/extension/assets/icon16.png"

# Test sheets: the skill's full sheet (sizes, backgrounds, one-colour, reversed, blur, mirror) and a
# pixel-zoomed Chrome-toolbar sheet (16/32 px on light and dark toolbars).
python3 "$SKILL/preview_sheet.py" "$B/mark.svg" "$B/mark-small.svg" \
  --names "mark" "mark (small cut)" --name Kitestring --brand-color "#D63B1F" \
  --refs-industry developer-tools -o "$B/.test-sheet.html"
python3 "$SKILL/render_png.py" "$B/.test-sheet.html" -o "$B/.test-sheet-full.png" --width 1400 --height 5200
python3 "$ROOT/scripts/brand/toolbar_sheet.py" "$B"
rm -f "$B/.test-sheet.html"
echo "done"
