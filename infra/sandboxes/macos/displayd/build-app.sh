#!/bin/sh
set -eu

cd "$(dirname "$0")"
bundle_id="${RAKAZO_DISPLAYS_BUNDLE_ID:-com.rakazo.displays}"
identity="${RAKAZO_DISPLAYS_SIGN_IDENTITY:--}"
app="${1:-build/RakazoDisplays.app}"

swift build -c release --product rakazo-displayd
bin="$(swift build -c release --show-bin-path)/rakazo-displayd"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/rakazo-displayd"
sed "s/@BUNDLE_ID@/$bundle_id/" Info.plist > "$app/Contents/Info.plist"
codesign --force --sign "$identity" --identifier "$bundle_id" "$app"
codesign --verify --strict "$app"
echo "$app"
