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

child_pid=""
kill_grace_seconds="${CODEX_WRAPPER_KILL_GRACE_SECONDS:-2}"

terminate_child_group() {
  if [ -z "$child_pid" ]; then
    return
  fi

  if ! kill -0 "-$child_pid" >/dev/null 2>&1 && ! kill -0 "$child_pid" >/dev/null 2>&1; then
    return
  fi

  kill -TERM "-$child_pid" >/dev/null 2>&1 || kill -TERM "$child_pid" >/dev/null 2>&1 || true
  sleep "$kill_grace_seconds"
  if kill -0 "-$child_pid" >/dev/null 2>&1 || kill -0 "$child_pid" >/dev/null 2>&1; then
    kill -KILL "-$child_pid" >/dev/null 2>&1 || kill -KILL "$child_pid" >/dev/null 2>&1 || true
  fi
}

handle_term() {
  terminate_child_group
  exit 143
}

handle_int() {
  terminate_child_group
  exit 130
}

handle_hup() {
  terminate_child_group
  exit 129
}

run_real_codex() {
  set -m
  trap handle_term TERM
  trap handle_int INT
  trap handle_hup HUP

  "$@" &
  child_pid=$!

  set +e
  wait "$child_pid"
  status=$?
  set -e

  terminate_child_group
  child_pid=""
  trap - TERM
  trap - INT
  trap - HUP
  exit "$status"
}

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

  run_real_codex "$REAL_CODEX" exec --dangerously-bypass-hook-trust "${args[@]}"
fi

run_real_codex "$REAL_CODEX" "$@"
