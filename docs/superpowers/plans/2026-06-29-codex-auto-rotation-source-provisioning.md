# Codex Auto Rotation Source Provisioning Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Move the proven ALB-1011 Codex auto thread rotation plus abort soft-wedge fix into canonical TeleCodex so future Codex dispatcher bots inherit it from source.

Architecture: Keep rotation as thin TeleCodex glue: pure token-threshold policy, pure handoff rendering, small JSON state persistence beside .telecodex/contexts.json, and a lazy rotate-before-next-turn hook in src/bot.ts. Keep soft-wedge recovery at the SDK event-stream boundary in src/codex-session.ts.

Tech Stack: TypeScript, @openai/codex-sdk, grammY, Vitest, Node fs persistence.

---

### Task 1: Red Tests for Rotation Config and Pure Units

Files:
- Create after red: src/rotation-policy.ts, src/handoff-buffer.ts, src/thread-rotation.ts, src/handoff-store.ts.
- Modify: src/config.ts, test/config.test.ts.
- Test: test/rotation-policy.test.ts, test/handoff-buffer.test.ts, test/thread-rotation.test.ts, test/handoff-store.test.ts.

- [x] Step 1: Add tests that expect CODEX_AUTO_ROTATE default enabled, CODEX_ROTATE_THRESHOLD=0.6, and CODEX_MODEL_CONTEXT_WINDOW=400000.
- [x] Step 2: Add pure tests for threshold decisions, bounded handoff rendering, sticky pending rotation, and durable state round-trip.
- [x] Step 3: Run npm test -- test/config.test.ts test/rotation-policy.test.ts test/handoff-buffer.test.ts test/thread-rotation.test.ts test/handoff-store.test.ts -- --reporter=dot; expected red: missing modules/config fields.

### Task 2: Red Tests for Bot Wiring

Files:
- Modify: src/bot.ts, src/prompt-guard.ts, test/bot.test.ts.

- [x] Step 1: Add a bot test where turn 1 reports heavy input tokens and turn 2 starts a fresh thread with a handoff preamble containing turn 1 and turn 2.
- [x] Step 2: Add tests proving light turns and disabled rotation do not rotate.
- [x] Step 3: Add a regression test proving a transient newThread() failure keeps the pending rotation for the following turn.
- [x] Step 4: Run npm test -- test/bot.test.ts -t auto-rotates -- --reporter=dot and related focused cases; expected red: no rotation behavior.

### Task 3: Red Test for Codex Stream Soft-Wedge

Files:
- Modify: src/codex-session.ts, test/codex-session.test.ts.

- [x] Step 1: Add a test where runStreamed() returns an async iterator that never yields and ignores abort.
- [x] Step 2: Run npm test -- test/codex-session.test.ts -t soft-wedge -- --reporter=dot; expected red: isProcessing() remains true after abort().

### Task 4: Minimal Green Implementation

Files:
- Add: src/rotation-policy.ts, src/handoff-buffer.ts, src/thread-rotation.ts, src/handoff-store.ts.
- Modify: src/config.ts, src/prompt-guard.ts, src/bot.ts, src/codex-session.ts.

- [x] Step 1: Implement pure modules with bounded defaults: threshold 0.45, context window 258400, max handoff entries 20, per-entry chars 800, total handoff chars 6000.
- [x] Step 2: Add autoRotate to TeleCodexConfig and env parsing with invalid values falling back safely.
- [x] Step 3: Add withRotationHandoff() to prepend the handoff before the existing Telegram reply guard.
- [x] Step 4: In createBot(), persist per-context rotation state under .telecodex, take a pending handoff before a prompt, call session.newThread(), inject the handoff only if rotation succeeded, and preserve pending state if newThread() fails.
- [x] Step 5: In CodexSessionService, wrap the SDK async event stream so abort() settles even when the iterator never advances.

### Task 5: Source Provisioning Documentation

Files:
- Modify: .env.example, README.md.

- [x] Step 1: Document CODEX_AUTO_ROTATE, CODEX_ROTATE_THRESHOLD, and CODEX_MODEL_CONTEXT_WINDOW; default new bots inherit rotation without manual env.
- [x] Step 2: Add a README feature note explaining automatic thread rotation and handoff state persistence.
- [x] Step 3: Do not modify production CC bot/session/supervisor. If the Claude global builder skill needs later canonical sync, record it as a separate Linear handoff unless Albert explicitly approves editing that repo.

### Task 6: Verification and Evidence

Files:
- Linear evidence on ALB-831; issue lineage ALB-1025.

- [x] Step 1: Run targeted red/green commands from Tasks 1-3.
- [x] Step 2: Run npm test -- --reporter=dot, npm run build -- --pretty false, and git diff --check. Result: 26 files / 526 tests passed; build passed; diff check passed.
- [x] Step 3: Run an independent review pass; fixed Important findings for post-newThread prompt failure, manual session switch stale rotation, and echoed handoff stripping.
- [x] Step 4: Record rollback: disable with CODEX_AUTO_ROTATE=false or revert branch alb-1025-auto-rotation-ada; no production bot reload without Albert approval.
- [ ] Step 5: Live proof remains gated: use an isolated disposable/test bot path only after checking no double poller; do not reload production Theo/CC without Albert approval.

