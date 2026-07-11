#!/usr/bin/env python3
"""Inject the shared Linear and HANDOFF continuity contract on every Codex turn."""

import json
import sys

CONTEXT = (
    "Codex core work contract: for Albert system work, search Linear before creating an issue; "
    "write close criteria immediately; set a real priority plus exactly one tenant, lane, and bot ownership labels; "
    "keep checkpoint, red, green, review, deploy, live proof, rollback, risk, and handoff evidence current. "
    "On a rotated or resumed thread, read the HANDOFF and every listed Linear issue/comments/status/close criteria, "
    "then continue the true unanswered message or last breakpoint without inventing new scope. "
    "Child issues close against their own criteria; the parent waits for Albert approval."
)

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError, TypeError):
        print("invalid UserPromptSubmit payload", file=sys.stderr)
        return 2
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "UserPromptSubmit":
        print("expected UserPromptSubmit hook event", file=sys.stderr)
        return 2
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": CONTEXT,
        }
    }, sys.stdout)
    print()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
