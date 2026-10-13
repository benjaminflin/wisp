#!/usr/bin/env bash
#
# One-time setup for Wisp: builds the Python side, installs Node packages,
# generates icons, and pre-downloads the Whisper model so the first dictation
# is not slow.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODEL="${WISP_MODEL:-mlx-community/whisper-large-v3-turbo}"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Keep every cache inside the project so setup never needs permission to write
# to system locations.
export PIP_CACHE_DIR="$ROOT/.pipcache"
export HF_HOME="$ROOT/.hf"
export HF_HUB_DISABLE_TELEMETRY=1
export npm_config_cache="$ROOT/.npmcache"
# @electron/get only honours this lowercase name for its download cache.
export electron_config_cache="$ROOT/.electroncache"
export ELECTRON_BUILDER_CACHE="$ROOT/.electron-builder-cache"

command -v python3 >/dev/null || fail "python3 is required"
command -v node >/dev/null || fail "node is required"

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
say "Using Python $PY_VERSION at $(command -v python3)"
case "$PY_VERSION" in
  3.1[0-9]|3.[2-9][0-9]) ;;
  *) fail "Python 3.10+ is required (found $PY_VERSION)" ;;
esac

if [ ! -d .venv ]; then
  say "Creating the Python virtual environment in .venv"
  python3 -m venv .venv
fi

say "Installing Python dependencies (sounddevice, mlx-whisper)"
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/pip install --quiet sounddevice mlx-whisper

say "Installing Node dependencies"
npm install --no-fund --no-audit

say "Generating icons"
.venv/bin/python scripts/make_icons.py

say "Pre-downloading the Whisper model ($MODEL)"
say "This is a one-time download of roughly 1.6 GB."
.venv/bin/python - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
path = snapshot_download(sys.argv[1])
print(f"   cached at {path}")
PY

cat <<'EOF'

Setup complete. Two macOS permissions are needed before dictation works:

  1. Microphone    - System Settings > Privacy & Security > Microphone
                     Grant it to the terminal you launched Wisp from
                     (or to Wisp itself once packaged).

  2. Accessibility - needed only for the hold-a-key trigger.
                     System Settings > Privacy & Security > Accessibility
                     Add the same terminal or Wisp, then restart Wisp.

Qwen cleanup runs through Ollama. If it is not already running:

     ollama serve
     ollama pull qwen2.5:7b

Then start the app:

     npm start

EOF
