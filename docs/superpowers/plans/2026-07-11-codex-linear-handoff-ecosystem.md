# Codex Linear + HANDOFF Ecosystem Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sp-subagent-driven-development (recommended) or sp-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linear lifecycle discipline and seamless cross-thread HANDOFF a source-level capability inherited by Theo, Ada, and every newly built Codex Bot.

**Architecture:** Keep TeleCodex thin. Reuse the validated CC recovery contract—owner wording, unanswered work, active Linear control plane, last breakpoint, and recent turns—inside the existing TypeScript rotation state. Add one bounded mailbox resume after a context-pressure timeout. Package the per-turn contract in the shared role-bundle seam; do not import CC's Python runtime or add Memory.

**Tech Stack:** TypeScript, Vitest, Python 3 Codex hook/installers, persisted TeleCodex rotation state.

---

### Task 1: Full Linear lifecycle contract on every turn

**Files:**
- Modify: `src/prompt-guard.ts`
- Test: `test/prompt-guard.test.ts`

- [ ] Add failing assertions for both Telegram and mailbox prompts:

```ts
expect(text).toContain("search for an existing Linear issue before creating one");
expect(text).toContain("write a close-criteria comment immediately");
expect(text).toContain("exactly one tenant:* label");
expect(text).toContain("exactly one lane:* label");
expect(text).toContain("one bot:* ownership label");
expect(text).toContain("checkpoint, red, green, review, deploy, and live proof");
expect(text).toContain("do not move the parent issue to Done before Albert approves");
```

Also prove every injected line is stripped if echoed.

- [ ] Run `npm test -- --run test/prompt-guard.test.ts`; expect RED because the current guard has only the short Linear-first form.
- [ ] Extend `DEVELOPER_DISCIPLINE_GUARD` with the exact search-before-create, close-criteria, priority, three-label, lifecycle-evidence, child/parent closure rules. Do not add another database or background auto-creator.
- [ ] Run focused and full tests; expect PASS.
- [ ] Commit: `Refs ALB-714 ALB-958 enforce full Linear lifecycle per turn`.

### Task 2: Explicit Linear references in HANDOFF

**Files:**
- Modify: `src/handoff-buffer.ts`
- Modify: `src/thread-rotation.ts`
- Test: `test/handoff-buffer.test.ts`
- Test: `test/thread-rotation.test.ts`

- [ ] Add a failing renderer test:

```ts
const text = renderHandoff([], {
  reason: "threshold",
  linearIssues: ["ALB-1201", "alb-958", "ALB-1201"],
});
expect(text).toContain("--- Linear 在途控制面 ---");
expect(text).toContain("ALB-1201");
expect(text).toContain("ALB-958");
expect(text.match(/ALB-1201/g)).toHaveLength(1);
expect(text).toContain("issue/comments/status/close criteria");
```

Add a failing orchestration test proving issue IDs are extracted from recent turns, unanswered messages, and the interrupted turn.

- [ ] Run `npm test -- --run test/handoff-buffer.test.ts test/thread-rotation.test.ts`; expect RED.
- [ ] Add `linearIssues?: string[]` to `HandoffContext`.
- [ ] In `thread-rotation.ts`, extract `/\bALB-\d+\b/gi`, uppercase, deduplicate in encounter order, cap at 20, and pass it to the renderer.
- [ ] Render a protected section before recent answered turns:

```ts
"--- Linear 在途控制面 ---\n" +
"- refs: " + issues.join(", ") + "\n" +
"- 必须逐张读取 issue/comments/status/close criteria，再沿真实断点续做。"
```

The existing total budget remains; recent answered conversation yields first.

- [ ] Run focused/full tests and commit: `Refs ALB-1205 preserve Linear control plane across rotation`.

### Task 3: Automatically resume one mailbox timeout

**Files:**
- Modify: `src/thread-rotation.ts`
- Modify: `src/handoff-store.ts`
- Modify: `src/mailbox.ts`
- Test: `test/thread-rotation.test.ts`
- Test: `test/handoff-store.test.ts`
- Test: `test/mailbox.test.ts`

- [ ] Add a failing two-tick mailbox regression: turn A finishes above threshold; message B times out; first tick keeps B unread and persists the breakpoint; second tick creates a fresh thread, injects HANDOFF + B, completes once, replies once, and archives B.

Core assertions:

```ts
expect(first.processed).toBe(1);
expect(first.skipped).toBe(1);
expect(await pathExists(messageBPath)).toBe(true);
expect(second.processed).toBe(1);
expect(session.newThread).toHaveBeenCalledTimes(1);
expect(JSON.stringify(session.prompt.mock.calls.at(-1)?.[0])).toContain("最后断点");
expect(await pathExists(messageBPath)).toBe(false);
```

Add a repeated-timeout test proving the message is quarantined after one automatic retry.

- [ ] Run focused tests; expect RED because the current timeout path quarantines B immediately, leaving no trigger to consume the saved breakpoint.
- [ ] Add `interruptedAttempts?: number` to `ChatRotationState`; persist/load it. Same descriptor increments; a new descriptor starts at one.
- [ ] At the timeout boundary only: first heavy timeout leaves the inbox file unread and breaks after existing abort-grace handling; repeated timeout uses the current quarantine path. Leave Telegram, normal mailbox success, hard-cap refusal, and receipts unchanged.
- [ ] Run focused/full tests plus `npm run build`; commit: `Refs ALB-1205 resume one interrupted mailbox turn after rotation`.

### Task 4: Shared new-Bot default

**Files:**
- Create: `scripts/codex-core-discipline-turn-context.py`
- Modify: `scripts/install-codex-role-bundles.py`
- Modify: `scripts/codex-bot-role-bundles.json`
- Modify: `scripts/install-codex-graphify-bundle.py`
- Test: `test/install-codex-role-bundles.test.ts`
- Create: `test/codex-core-discipline-turn-context.test.ts`

- [ ] Add failing newborn tests for all three roles:

```ts
expect(receipt.installed_bundles).toContain("core-discipline");
expect(readFileSync(join(codexHome, "hooks.json"), "utf8"))
  .toContain("codex-core-discipline-turn-context.py");
```

Developer retains graphify; Personal roles do not get graphify. Running the installed `UserPromptSubmit` hook must return the Linear-first lifecycle and HANDOFF recovery contract.

- [ ] Run focused tests; expect RED because only Developer currently gets graphify and Personal roles get no default bundle.
- [ ] Add `core-discipline` as the first bundle for all roles. Make the role installer own one deterministic managed `hooks.json`: all roles get core context; Developer additionally gets graphify context and PreToolUse entries. Unknown/unmanaged hook documents fail closed; two installs are byte-identical.
- [ ] Do not install Memory, Graphiti, persona-memory, or a private graph.
- [ ] Run focused/full tests and build; commit: `Refs ALB-1208 make Linear and HANDOFF discipline a Codex Bot default`.

### Task 5: Closed-loop proof before rollout

**Files:**
- Create: `docs/ops/2026-07-11-alb1201-linear-handoff-ecosystem-proof.md`
- Sync workspace `CURRENT_HANDOFF.md` only after Linear evidence is written.

- [ ] Run full tests/build and install each role twice into temp directories. Negative proof: Personal has no graphify; all roles have core discipline; no Memory/Graphiti connector exists.
- [ ] Run required independent review; fix every Critical/Important finding through a new red/green cycle.
- [ ] Build a fresh isolated Developer Testbot and prove: Linear is used before code work; issue has priority/close criteria/one tenant/one lane/one bot label; lifecycle evidence survives forced rotation; queued messages answer exactly once; heavy mailbox timeout resumes once; production state remains untouched.
- [ ] Do not deploy/reload while Cody's deployment freeze is active. When released, verify no double poller and roll Theo then Ada one at a time. Rollback is prior build plus `CODEX_AUTO_ROTATE=false`.
- [ ] Write evidence to ALB-714, ALB-958, ALB-1205/1350 as applicable, ALB-1208, and ALB-1201. Do not close the parent before Albert approves.
