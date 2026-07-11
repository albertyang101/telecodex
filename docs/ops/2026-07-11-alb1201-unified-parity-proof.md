# ALB-1201 Unified Codex Parity Integration Proof

Date: 2026-07-11 AEST
Branch: alb-1201-unified-parity
Base: 1d7393758b9a32065d7c105cbeeb9e530f559c73
Head before this proof commit: 3b6d832

## Integrated source contracts

The candidate preserves the ecosystem base and adds the three reviewed basic-experience commits in order:

- 3242864: completed Codex messages are delivered as separate Telegram bubbles; long-message chunks remain ordered; transport failure does not stop later messages; typing remains active through delivery.
- 31723a5: Telegram ingress audit records only a coarse media class and does not expose body, caption, file id, filename, or MIME data.
- 3b6d832: Telegram native Reply preserves replied text/caption separately from the current visible message; retry preserves original-message pending-answer tracking.

The base already contains source-first runtime guards, full Linear lifecycle discipline, Linear-aware HANDOFF, one automatic mailbox resume after a heavy timeout, shared graphify enforcement, and newborn role-bundle defaults.

## Integration RED and root cause

The first focused integration run produced two expected failures in the existing ALB-1361 typing tests. Both tests were still blocking the legacy edit-in-place Telegram seam, while the reviewed bubble implementation now delivers completed messages through sendMessage.

The minimal integration fix changed only the tests' transport observation point from editMessageText to sendMessage. No production behavior was added for this compatibility fix.

## Fresh GREEN evidence

- Focused bubble/typing/rotation/mailbox/prompt suite: 5 files, 196 tests passed.
- Focused image and bot suite after media replay: 2 files, 74 tests passed.
- Focused Reply/image suite after Reply replay: 2 files, 77 tests passed.
- Final Python compile for graphify/core installers and hooks: exit 0.
- Final full npm test: 38 files, 703 tests passed, 0 failed.
- Final npm run build: exit 0.
- git diff --check: exit 0.
- Base ancestry check: exit 0; the three reviewed commits are consecutive descendants of 1d73937.

## Safety, rollback, and remaining gates

- Work occurred only in the isolated alb-1201-unified-parity worktree.
- No Theo, Ada, CC bot, Codex Testbot poller, launch profile, production runtime, token, supervisor, or Memory/Graphiti system was changed.
- Source rollback is the verified base 1d73937.
- Live rollback remains the prior immutable runtime plus the existing audited per-bot restart helper.
- Still required: independent review of the combined range, immutable Codex Testbot build, full Telegram live matrix, builder completion, four dedicated Codex Testbot runtimes, and Albert's rollout gate before Theo/Ada production changes.
