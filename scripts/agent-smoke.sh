#!/usr/bin/env bash
# Agent smoke test: a real agent drives the torture basic-form through the Kitestring MCP tools.
#   scripts/agent-smoke.sh [claude|opencode] [--yes]
# WARNING: this spends your agent credits. Never run in CI.
set -euo pipefail

AGENT=""
YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    claude|opencode) AGENT="$a" ;;
    *) echo "usage: $0 [claude|opencode] [--yes]" >&2; exit 2 ;;
  esac
done
AGENT="${AGENT:-claude}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KITE=(node "$ROOT/packages/cli/dist/bin.js")
PORT="${PORT:-4173}"
EXPECTED="submitted:Ada:ada@x.io"

echo "== Kitestring agent smoke test ($AGENT) =="
echo "!! This runs a real agent and SPENDS YOUR AGENT CREDITS. Do not run in CI."

[ -f "$ROOT/packages/cli/dist/bin.js" ] || { echo "build first: pnpm build" >&2; exit 2; }
command -v "$AGENT" >/dev/null || { echo "'$AGENT' not found on PATH" >&2; exit 2; }

# Require bridge + extension ok (other doctor checks may fail without blocking this test).
CHECKS="$("${KITE[@]}" --json doctor || true)"
if ! printf '%s' "$CHECKS" | node -e '
  const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const bad = ["bridge", "extension"].filter((id) => !c.find((x) => x.id === id && x.ok));
  if (bad.length) { console.error("kite doctor: not ok: " + bad.join(", ")); process.exit(1); }
'; then
  echo "Refusing to run: run 'kite doctor' and fix bridge/extension first." >&2
  exit 1
fi

if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then
    read -r -p "Run $AGENT now and spend credits? [y/N] " ans
    case "$ans" in y|Y|yes) ;; *) echo "aborted"; exit 1 ;; esac
  else
    echo "Refusing to run non-interactively without --yes." >&2
    exit 1
  fi
fi

# Start the torture site.
(cd "$ROOT/apps/torture" && PORT="$PORT" pnpm exec tsx server.ts) >/tmp/kite-smoke-torture.log 2>&1 &
TORTURE_PID=$!
trap 'kill "$TORTURE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/basic-form" && break
  sleep 0.2
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/basic-form" || { echo "torture site did not start (see /tmp/kite-smoke-torture.log)" >&2; exit 1; }

URL="http://127.0.0.1:$PORT"
PROMPT="Use the kitestring tools: open $URL/basic-form, fill Name with Ada and Email with ada@x.io, submit, then report the page's window.__result via a snapshot of the confirmation"

case "$AGENT" in
  claude) claude -p "$PROMPT" --allowedTools "mcp__kitestring__*" ;;
  opencode) opencode run "$PROMPT" ;;
esac

GOT="$(curl -fs "$URL/__last-result" || true)"
if [ "$GOT" = "$EXPECTED" ]; then
  echo "PASS: torture recorded '$GOT'"
else
  echo "FAIL: expected '$EXPECTED', torture recorded '${GOT:-<nothing>}'" >&2
  exit 1
fi
