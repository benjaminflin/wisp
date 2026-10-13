#!/usr/bin/env bash
#
# Builds the relocatable Python runtime that ships inside Wisp.app.
#
# The app must not depend on the machine it was built on. A virtualenv records
# the absolute path of the interpreter that created it, which is precisely what
# breaks when someone else downloads the app. This uses python-build-standalone
# instead: a redistributable CPython whose prefix is derived from the location
# of its own executable, so the whole tree can be moved anywhere.
#
# Output: build/python-runtime/python  ->  Wisp.app/Contents/Resources/python

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY_SERIES="${WISP_PY_SERIES:-3.13}"
CACHE="$ROOT/build/cache"
RUNTIME="$ROOT/build/python-runtime"
STAMP="$RUNTIME/.interpreter"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this runtime is macOS-only"
[ "$(uname -m)" = "arm64" ] || fail "only Apple Silicon is supported (found $(uname -m))"

mkdir -p "$CACHE" build

TARBALL="$(find "$CACHE" -maxdepth 1 -name "cpython-${PY_SERIES}.*-aarch64-apple-darwin-install_only.tar.gz" 2>/dev/null | sort | tail -1)"

if [ -z "$TARBALL" ]; then
  say "Resolving the latest python-build-standalone release"
  TARBALL="$(python3 - "$PY_SERIES" "$CACHE" <<'PY'
import json, pathlib, sys, urllib.request

series, cache = sys.argv[1], pathlib.Path(sys.argv[2])
api = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
req = urllib.request.Request(api, headers={"User-Agent": "wisp-build"})
data = json.load(urllib.request.urlopen(req, timeout=120))
asset = next(
    a
    for a in data["assets"]
    if a["name"].endswith("aarch64-apple-darwin-install_only.tar.gz")
    and series in a["name"]
    and "freethreaded" not in a["name"]
)
dest = cache / asset["name"]
if not (dest.exists() and dest.stat().st_size == asset["size"]):
    req = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "wisp-build"})
    with urllib.request.urlopen(req, timeout=1800) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
print(dest)
PY
)"
fi

say "Interpreter: $(basename "$TARBALL")"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(basename "$TARBALL")" ] && [ -x "$RUNTIME/bin/python3" ]; then
  say "Runtime is already built from this interpreter; nothing to do"
  exit 0
fi

rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
say "Extracting the interpreter"
# Drop the archive's own "python/" wrapper so the runtime root maps straight to
# Wisp.app/Contents/Resources/python-runtime.
tar -xzf "$TARBALL" -C "$RUNTIME" --strip-components=1

PY="$RUNTIME/bin/python3"
[ -x "$PY" ] || fail "expected an interpreter at $PY"

say "Installing sounddevice and mlx-whisper into the runtime"
export PIP_CACHE_DIR="$ROOT/.pipcache"
export HF_HOME="$ROOT/.hf"
"$PY" -m pip install --disable-pip-version-check --no-warn-script-location --quiet --upgrade pip
"$PY" -m pip install --disable-pip-version-check --no-warn-script-location --quiet sounddevice mlx-whisper

# mlx-whisper declares torch, but only its PyTorch-checkpoint conversion utility
# imports it; transcription never does. Dropping it takes ~580 MB out of the
# runtime, and therefore out of every download. Set WISP_KEEP_TORCH=1 to keep.
if [ "${WISP_KEEP_TORCH:-0}" != "1" ] && "$PY" -c "import torch" >/dev/null 2>&1; then
  say "Removing torch (verified unused by dictation)"
  "$PY" -m pip uninstall -y --quiet torch
fi

say "Verifying the runtime imports what it needs"
"$PY" - <<'PY'
import numpy, sounddevice, mlx_whisper  # noqa: F401
print("   numpy, sounddevice and mlx_whisper all import")
PY

printf '%s' "$(basename "$TARBALL")" > "$STAMP"
say "Runtime ready"
du -sh "$RUNTIME"
