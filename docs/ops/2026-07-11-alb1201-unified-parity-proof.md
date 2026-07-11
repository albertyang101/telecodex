# ALB-1201 Unified Codex Parity Integration Proof

Date: 2026-07-12 AEST
Branch: alb-1201-unified-parity
Reviewed code head: aba3024
Control plane: Linear ALB-1201 with child evidence in ALB-747, ALB-1379, and ALB-1388

## Integrated contracts

The candidate keeps TeleCodex as the thin Telegram bridge and aligns final capability with CC except for the explicitly different dispatcher implementation.

- Telegram output uses Codex event lifecycle metadata: useful intermediate milestones and direct questions are separate bubbles; process narration is suppressed; final messages are always preserved.
- A provider failure preserves any unsent completed result, a newer partial, and the failure notice in order without duplicate bubbles.
- Tool status shares the same delivery sequence as agent bubbles, so it cannot overtake preceding progress.
- Typing remains active for the entire foreground/tool/background turn and stops only after final Telegram delivery.
- Photo plus caption, native Reply context, long-message chunking, and transport retry remain integrated.
- Per-turn Linear discipline, Linear-aware rotation HANDOFF, pending-answer recovery, and one bounded mailbox resume are included.
- Graphify is enforced before code inspection/editing through the audited wrapper with unified_exec disabled; Personal Memory/Graphiti remains disconnected.
- Mailbox processing claims before side effects, quarantines poison messages, continues later mail after persistence failures, and validates terminal receipts by status, identity, bridge, and mailbox-contained path.

## RED and root-cause evidence

The integration was driven by failing tests at the earliest reliable boundaries.

- Legacy edit-in-place typing tests failed after the reviewed bubble transport moved completed messages to separate sends; the tests were corrected to observe the actual transport.
- Text-regex bubble filtering both leaked narration and discarded useful results. The fix moved classification to Codex event lifecycle metadata.
- Failure recovery lost an unsent completed result when a newer partial existed. The fix composes all undelivered failure parts once and in order.
- Generic question marks and confirmation keywords leaked process narration. The fix separates structured updates, direct questions, and process-prefixed declarative narration.
- Tool status could overtake a blocked progress send. The fix serializes both through one delivery promise.
- A forged mailbox receipt could be trusted as terminal, while an authentic processed receipt could be rejected because it points to archive rather than inbox. The fix validates an allowlisted terminal status and derives the correct status-specific path.
- unified_exec bypassed the official PreToolUse hook surface. The SDK now disables unified_exec while the audited wrapper keeps hook trust explicit.

## Fresh GREEN evidence

- Full test suite at reviewed code head aba3024: 38 files, 720 tests passed, 0 failed.
- Focused output review suite: 147 passed.
- Focused mailbox review suite: 86 passed.
- TypeScript build: passed.
- Graphify policy Python compile: passed.
- git diff --check: passed.
- Integration worktree tracked status: clean after every commit.

## Independent review

- Graphify gate: Critical 0, Important 0.
- Mailbox claim and receipt recovery: Critical 0, Important 0, Minor 0, Ready.
- Output lifecycle on aba3024: Critical 0, Important 0, Minor 0, Ready.
- Ada independently found additional output edge cases that the general reviewer missed; all findings received through 1594ceb are covered by later RED/GREEN tests. Her exact aba3024 sign-off remains a deployment gate.

## Deployment, rollback, and remaining gates

No production or Testbot runtime was changed by this integration work.

Cody remains the deployment owner. After Ada signs the reviewed code head, Cody must:

1. Create a fresh immutable runtime from the reviewed commit; never deploy from the mutable integration worktree.
2. Confirm one poller only and record the previous immutable runtime as rollback.
3. Run Testbot-first Telegram proofs for bubble lifecycle, output density, provider failure, typing, photo plus caption, Reply, rotation HANDOFF, Linear evidence, Graphify adversarial no-write, and mailbox fault recovery.
4. Record exact sent/reply identifiers and timestamps without secrets.
5. Stop on any Critical or Important regression, restore the previous immutable runtime, and update Linear.
6. Keep canonical, integration, and immutable runtime tracked-clean before any Theo or Ada rollout.

Known residual dependency audit from the controlled npm install: 5 existing findings (1 low, 1 moderate, 2 high, 1 critical). Cody must record these as residual risk; they are not silently accepted or fixed by this change.

Theo/Ada production rollout, four dedicated Codex Testbot runtimes, builder completion, and Albert's final acceptance remain open. Parent ALB-1201 must not be closed before Albert approves the live result.
