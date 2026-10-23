#!/bin/sh
set -eu

PROFILE="${1:?usage: chrome.sh <profile dir>}"
PORT="${MAC_SCREENS_CHROME_PORT:-9333}"
CHROME="${MAC_SCREENS_CHROME_APP:-/Applications/Google Chrome.app}/Contents/MacOS/Google Chrome"

mkdir -p "$PROFILE"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PORT" \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-first-run \
  --no-startup-window \
  --no-default-browser-check \
  --hide-crash-restore-bubble
