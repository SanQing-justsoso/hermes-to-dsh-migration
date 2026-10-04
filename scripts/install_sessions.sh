#!/usr/bin/env bash
# Install / reconcile migrated Hermes sessions into DeepSeek Harness.
# Idempotent + self-reconciling: removes prior buggy imports (detected by a strict
# signature only our imports have), overwrites in place with the current valid
# sessions (same ids), and reconciles ~/.dsh/storages/workspace.json.
# Best run with DSH quit. Hermes is never touched.
set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"                 # .../dsh-import
STAGING="$PKG/sessions"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WS_PATH="${WS_PATH:?set WS_PATH to the DSH workspace cwd (e.g. /path/to/workspace)}"
DIR_NAME="$(printf '%s' "$WS_PATH" | sed 's#/#-#g')"  # slashes -> dashes
DIR_NAME="--${DIR_NAME#-}--"
SESSIONS_DST="$DSH_HOME/sessions/$DIR_NAME"
WSJSON="$DSH_HOME/storages/workspace.json"

# locate node
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "$NODE_BIN" ]; then echo "!! node not found; install Node or set PATH"; exit 1; fi

echo "== node: $NODE_BIN"
echo "== sessions dir: $SESSIONS_DST"
mkdir -p "$SESSIONS_DST"

# back up workspace.json
if [ -f "$WSJSON" ]; then
  cp "$WSJSON" "$WSJSON.bak-preresessionimport-$(date +%Y%m%d-%H%M%S)"
fi

echo "== reconciling (remove stale imports, install valid sessions, fix workspace.json)"
"$NODE_BIN" "$PKG/deploy.mjs" "$SESSIONS_DST" "$STAGING" "$WSJSON" apply

echo "== done. Reopen DeepSeek Harness; titles come from the imported session/title events."
echo "   (Your live/ongoing session is never touched — only prior Hermes imports are replaced.)"
