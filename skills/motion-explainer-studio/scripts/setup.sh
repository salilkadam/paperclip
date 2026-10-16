#!/usr/bin/env bash
# One-time setup. Safe to re-run; it only installs what is missing.
#
#   bash scripts/setup.sh
#
# Everything else the skill needs is inside this directory — no other downloads,
# no external AI services, no Node toolchain.
set -uo pipefail

ok=0; miss=0
say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "== motion-explainer-studio setup =="

# --- ffmpeg / ffprobe -------------------------------------------------------
for bin in ffmpeg ffprobe; do
  if have "$bin"; then say "  ok      $bin"; ok=$((ok+1)); else
    miss=$((miss+1))
    say "  MISSING $bin"
    case "$(uname -s)" in
      Darwin) say "          brew install ffmpeg" ;;
      Linux)  say "          sudo apt-get install -y ffmpeg   # or your package manager" ;;
    esac
  fi
done

# --- python ------------------------------------------------------------------
if have python3; then
  say "  ok      $(python3 --version 2>&1)"
else
  say "  MISSING python3"; miss=$((miss+1))
fi

# --- playwright + chromium ---------------------------------------------------
if python3 -c "import playwright" 2>/dev/null; then
  say "  ok      playwright"
else
  say "  ..      installing playwright"
  pip install playwright --break-system-packages -q 2>/dev/null || pip install playwright -q
fi

if python3 -c "import playwright" 2>/dev/null; then
  say "  ..      ensuring chromium is downloaded"
  python3 -m playwright install chromium >/dev/null 2>&1 || true
  # A headless Chromium on a bare Linux box needs a handful of X libraries. This
  # is the single most common first-run failure and the error it produces
  # ("Target page, context or browser has been closed") says nothing useful, so
  # check it here instead.
  if python3 - <<'PY' 2>/dev/null
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    b.close()
PY
  then
    say "  ok      chromium launches"
  else
    miss=$((miss+1))
    say "  MISSING chromium cannot launch — system libraries are absent"
    say "          sudo python3 -m playwright install-deps chromium"
    say "          (macOS never needs this; Debian/Ubuntu containers usually do)"
  fi
else
  miss=$((miss+1)); say "  MISSING playwright — install it manually: pip install playwright"
fi

# --- Pillow (optional: transparent cutouts for generated art) ----------------
if python3 -c "import PIL" 2>/dev/null; then
  say "  ok      Pillow"
else
  say "  ..      installing Pillow (used to cut generated art out of its background)"
  pip install pillow --break-system-packages -q 2>/dev/null || pip install pillow -q
fi

# --- cluster key -------------------------------------------------------------
if [[ -n "${MCP_API_KEY:-}" ]]; then
  say "  ok      MCP_API_KEY is set"
elif bash "$(dirname "$0")/get_key.sh" >/dev/null 2>&1; then
  say "  ok      API key resolves via get_key.sh"
else
  say "  note    MCP_API_KEY is not set — voice/art/music stages will fail"
  say "          (it is platform-provided; report it. Rendering and assembly work without it)"
fi

say ""
if (( miss )); then
  say "$miss item(s) still missing — fix those, then re-run this script."
  exit 1
fi
say "Ready. Start with:"
say "  python3 scripts/mes.py init ./myvideo --title \"...\" "
say "  python3 scripts/mes.py ingest ./myvideo --url https://example.com --apply-theme"
