#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)

if [ -z "${REAL_CODEX:-}" ]; then
  if command -v codex >/dev/null 2>&1; then
    REAL_CODEX=$(command -v codex)
  elif [ -x /opt/homebrew/bin/codex ]; then
    REAL_CODEX=/opt/homebrew/bin/codex
  elif [ -x "$HOME/.local/bin/codex" ]; then
    REAL_CODEX="$HOME/.local/bin/codex"
  else
    echo "telecodex wrapper: unable to find codex; set REAL_CODEX to the real Codex CLI path" >&2
    exit 127
  fi
fi

if [ ! -x "$REAL_CODEX" ]; then
  echo "telecodex wrapper: REAL_CODEX is not executable: $REAL_CODEX" >&2
  exit 127
fi

CODEX_HOME="${CODEX_HOME:-$REPO_ROOT/.telecodex/codex-runtime-home}"
mkdir -p "$CODEX_HOME"
export CODEX_HOME

if [ "${1:-}" = "exec" ]; then
  shift
  args=()
  for arg in "$@"; do
    case "$arg" in
      --experimental-json)
        args+=("--json")
        ;;
      *)
        args+=("$arg")
        ;;
    esac
  done

  exec "$REAL_CODEX" exec --dangerously-bypass-hook-trust "${args[@]}"
fi

exec "$REAL_CODEX" "$@"
