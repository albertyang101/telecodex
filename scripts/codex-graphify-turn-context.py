#!/usr/bin/env python3
"""Inject the Albert graphify development contract on each Codex user turn."""

import json
import sys


CONTEXT = (
    "Developer code contract: before inspecting, debugging, or changing code, "
    "resolve the repository through the explicit repo map and query its canonical shared graph first. "
    "Use query then explain for ambiguous wiring, run affected before any code edit, "
    "never create or write a private graph, and verify important graph findings in source. "
    "If the mapped graph is missing or stale, state that limitation and follow the repository safety policy."
)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError, TypeError):
        print("invalid UserPromptSubmit payload", file=sys.stderr)
        return 2

    if not isinstance(payload, dict):
        print("invalid UserPromptSubmit payload", file=sys.stderr)
        return 2
    if payload.get("hook_event_name") != "UserPromptSubmit":
        print("expected UserPromptSubmit hook event", file=sys.stderr)
        return 2

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": CONTEXT,
            }
        },
        sys.stdout,
    )
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
