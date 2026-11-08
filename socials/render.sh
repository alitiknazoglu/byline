#!/usr/bin/env bash
# Render the social images in this folder from src/ with a headless Chromium browser.
# Usage: socials/render.sh   (set BROWSER to override the browser binary)
set -euo pipefail
cd "$(dirname "$0")"
SRC="file://$PWD/src"

BROWSER="${BROWSER:-}"
if [ -z "$BROWSER" ]; then
  for b in \
    $(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | tail -1) \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v chromium || true)" "$(command -v google-chrome || true)"; do
    if [ -n "$b" ] && [ -x "$b" ]; then BROWSER="$b"; break; fi
  done
fi
[ -n "$BROWSER" ] || { echo "No Chromium-based browser found; set BROWSER=/path/to/chrome" >&2; exit 1; }

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

shot() { # out.png width height url [transparent]
  local bg=--default-background-color=1e1e1eff
  [ "${5:-}" = transparent ] && bg=--default-background-color=00000000
  "$BROWSER" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --allow-file-access-from-files --force-device-scale-factor=1 \
    --virtual-time-budget=3000 "$bg" --window-size="$2,$3" --screenshot="$PWD/$1" "$4" >/dev/null 2>&1
  echo "wrote socials/$1 ($2×$3)"
}

shot logo.png            1024 1024 "$SRC/logo.html#icon"   transparent
shot logo-avatar.png     1024 1024 "$SRC/logo.html#avatar"
shot logo-wordmark-dark.png  1200 400 "$SRC/logo.html#dark"  transparent
shot logo-wordmark-light.png 1200 400 "$SRC/logo.html#light" transparent
shot preview.png         1200 630  "$SRC/preview.html"
