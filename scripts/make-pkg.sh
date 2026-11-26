#!/usr/bin/env bash
# Wraps the built .app in a macOS installer package that installs to /Applications.
# Usage: scripts/make-pkg.sh <path/to/Bracket Maker.app> <output.pkg>
set -euo pipefail
APP="$1"
OUT="$2"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
IDENT=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root"
ditto "$APP" "$WORK/root/$(basename "$APP")"
pkgbuild --root "$WORK/root" --install-location /Applications \
  --identifier "$IDENT.pkg" --version "$VERSION" "$WORK/component.pkg"
productbuild --package "$WORK/component.pkg" --identifier "$IDENT.installer" --version "$VERSION" "$OUT"
echo "Built $OUT"
