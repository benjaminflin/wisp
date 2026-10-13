#!/usr/bin/env bash
#
# Builds a distributable DMG from an already-packaged Wisp.app.
#
# electron-builder can produce a DMG itself, and does so with a nicer layout
# (background, icon positions). This script exists because that path drives
# `hdiutil create`, which Apple has deprecated and which restricted environments
# refuse outright. Doing the same job from the lower-level pieces means a DMG can
# still be produced:
#
#   diskutil image create blank    a read/write image
#   hdiutil attach -mountpoint     mounted inside the project, not /Volumes
#   ditto                          copies the bundle without breaking its signature
#   hdiutil convert -format UDZO   compressed, read-only result
#
# Usage:
#   scripts/make_dmg.sh [path/to/Wisp.app] [output.dmg]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="${1:-$ROOT/dist/mac-arm64/Wisp.app}"
OUT="${2:-}"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS only"
[ -d "$APP" ] || fail "no app bundle at $APP (run npm run dist first)"

NAME="$(basename "$APP" .app)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.0.0)"
[ -n "$OUT" ] || OUT="$ROOT/dist/${NAME}-${VERSION}-arm64.dmg"

WORK="$ROOT/build/dmg"
MNT="$WORK/mnt"
RW="$WORK/rw.dmg"
VERIFY_MNT="$ROOT/build/dmg-verify"

cleanup() {
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  hdiutil detach "$VERIFY_MNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$WORK" "$VERIFY_MNT"
mkdir -p "$MNT" "$VERIFY_MNT" "$(dirname "$OUT")"

# Headroom matters: an image sized to the app exactly will run out of space
# partway through the copy.
APP_MB="$(du -sm "$APP" | cut -f1)"
SIZE_MB=$(( APP_MB + APP_MB / 10 + 64 ))
say "Building ${NAME} ${VERSION} -> $(basename "$OUT") (${SIZE_MB} MB image)"

say "Creating a writable image"
diskutil image create blank --size "${SIZE_MB}m" --volumeName "$NAME" "$RW" >/dev/null

# Mounting inside the project rather than /Volumes keeps this working in
# sandboxed environments that only permit writes under the working directory.
say "Mounting"
hdiutil attach "$RW" -mountpoint "$MNT" -nobrowse -quiet

# ditto, not cp: it preserves the code signature and extended attributes, and a
# bundle whose signature is damaged will not launch at all.
say "Copying the app and the Applications shortcut"
ditto "$APP" "$MNT/${NAME}.app"
ln -s /Applications "$MNT/Applications"

say "Checking the copy still satisfies its signature"
codesign --verify --deep --strict "$MNT/${NAME}.app" >/dev/null 2>&1 \
  || fail "the copied app no longer verifies; ditto should have preserved it"

say "Unmounting"
hdiutil detach "$MNT" -quiet

say "Compressing"
# The read/write image lives inside $WORK, so convert it before clearing up.
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
rm -rf "$WORK"

say "Verifying the finished image"
hdiutil attach "$OUT" -mountpoint "$VERIFY_MNT" -nobrowse -quiet
[ -x "$VERIFY_MNT/${NAME}.app/Contents/MacOS/${NAME}" ] || fail "the DMG does not contain a runnable ${NAME}.app"
[ -L "$VERIFY_MNT/Applications" ] || fail "the Applications shortcut is missing"
codesign --verify --deep --strict "$VERIFY_MNT/${NAME}.app" >/dev/null 2>&1 \
  || fail "the signature does not survive inside the DMG"
hdiutil detach "$VERIFY_MNT" -quiet

say "Done"
ls -lh "$OUT"
