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

# The interpreter is pinned on purpose. Resolving "latest" through api.github.com
# made the build non-reproducible and, worse, unreliable: unauthenticated API
# calls are capped at 60 per hour per IP address, CI runners share addresses, and
# the release build duly died with HTTP 403. Release assets themselves are not
# rate limited, so this fetches a known-good asset directly and verifies it.
# Override WISP_PY_VERSION / WISP_PY_RELEASE / WISP_PY_SHA256 to bump it.
PY_VERSION="${WISP_PY_VERSION:-3.13.16}"
PY_RELEASE="${WISP_PY_RELEASE:-20261009}"
PY_SHA256="${WISP_PY_SHA256:-3338fcd572a670ec45ac9ef75480b95595ea9b6b5dd320952fcf5df185089941}"

CACHE="$ROOT/build/cache"
RUNTIME="$ROOT/build/python-runtime"
STAMP="$RUNTIME/.interpreter"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this runtime is macOS-only"
[ "$(uname -m)" = "arm64" ] || fail "only Apple Silicon is supported (found $(uname -m))"

mkdir -p "$CACHE" build

ASSET="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
TARBALL="$CACHE/$ASSET"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${ASSET}"

if [ ! -f "$TARBALL" ]; then
  say "Downloading ${ASSET}"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -o "$TARBALL.part" "$URL" \
    || fail "could not download ${URL}"
  mv "$TARBALL.part" "$TARBALL"
fi

if [ -n "$PY_SHA256" ]; then
  ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
  if [ "$ACTUAL" != "$PY_SHA256" ]; then
    rm -f "$TARBALL"
    fail "checksum mismatch for ${ASSET}
     expected ${PY_SHA256}
     actual   ${ACTUAL}"
  fi
  say "Checksum verified"
else
  say "WARNING: no checksum configured for ${ASSET}; skipping verification"
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
