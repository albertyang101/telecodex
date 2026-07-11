# Codex Developer Bot Graphify Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sp-subagent-driven-development (recommended) or sp-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every newly built Codex Developer Bot load the read-only shared graphify skill, receive a turn-scoped reminder, and enforce graph lookup before code access and affected lookup before edits.

**Architecture:** Package a thin graphify overlay plus explicit repo map as builder assets. Use a small UserPromptSubmit hook for per-turn developer context and the existing PreToolUse policy hook for deterministic gating and success receipts. Install and validate only in isolated CODEX_HOME/workspace fixtures until Cody approves deployment.

**Tech Stack:** Python 3 standard library, Codex hooks TOML, Vitest/TypeScript fixtures, official `codex exec`.

---

### Task 1: Preserve and verify the recovered graphify gate candidate

**Files:**
- Verify: `scripts/codex-pre-tool-use-policy.py`
- Verify: `scripts/codex-graphify-skill/SKILL.md`
- Verify: `scripts/codex-graphify-skill/references/repo-map.json`
- Test: `test/codex-pre-tool-use-policy.test.ts`
- Test: `test/codex-graphify-skill.test.ts`

- [ ] Run `npm test -- --run test/codex-pre-tool-use-policy.test.ts test/codex-graphify-skill.test.ts`; expect 128 passing tests.
- [ ] Run `npm test -- --run`; expect all test files and tests pass.
- [ ] Run `npm run build`; expect exit 0.
- [ ] Record exact counts in ALB-1379 and ALB-1201.

### Task 2: Add a turn-scoped graphify reminder with TDD

**Files:**
- Create: `scripts/codex-graphify-turn-context.py`
- Modify: `scripts/codex-graphify-hooks.toml`
- Create: `test/codex-graphify-turn-context.test.ts`
- Modify: `test/codex-graphify-skill.test.ts`

- [ ] Write a failing test that sends a `UserPromptSubmit` payload and expects stdout to include: canonical shared graph first, repo map, `affected` before edits, no private graph, and source verification.
- [ ] Write a failing test that malformed JSON exits non-zero without printing developer context.
- [ ] Write a failing config test requiring a `hooks.UserPromptSubmit` command entry.
- [ ] Run the new test file and confirm the failures are caused by the missing script/config.
- [ ] Implement the smallest dependency-free Python hook: parse stdin JSON, require `hook_event_name == "UserPromptSubmit"`, print one compact developer-context paragraph, exit 0.
- [ ] Add the UserPromptSubmit hook to the source config fragment.
- [ ] Re-run the new tests; expect all pass.
- [ ] Commit only Task 2 files with `Refs ALB-1379`.

### Task 3: Make the graphify bundle installable by the Bot builder

**Files:**
- Create: `scripts/install-codex-graphify-bundle.py`
- Create: `scripts/codex-graphify-bundle.json`
- Create: `test/install-codex-graphify-bundle.test.ts`
- Modify: `scripts/codex-graphify-hooks.toml`

- [ ] Write a failing test that installs into temporary `CODEX_HOME` and workspace roots and expects the Skill, repo map, hook scripts, and hooks config to exist at deterministic paths.
- [ ] Write a failing idempotency test: a second install produces byte-identical files and no duplicate hook blocks.
- [ ] Write a failing safety test: installer rejects targets inside the canonical shared graph root and rejects non-Developer roles.
- [ ] Run the installer test and verify the expected RED failures.
- [ ] Implement a standard-library installer that takes `--codex-home`, `--workspace`, and `--role developer`; copies only the reviewed bundle assets; substitutes absolute hook paths; writes via temporary files plus atomic replace; never executes graphify or Codex.
- [ ] Add a manifest with source asset names, target paths, and SHA-256 verification.
- [ ] Re-run installer tests; expect all pass.
- [ ] Commit only Task 3 files with `Refs ALB-1379 ALB-1208`.

### Task 4: Run fresh full verification

**Files:**
- Verify all modified files.

- [ ] Run targeted graphify tests; expect 0 failures.
- [ ] Run `npm test -- --run`; expect 0 failures.
- [ ] Run `npm run build`; expect exit 0.
- [ ] Run `git diff --check`; expect no output and exit 0.
- [ ] Run the Skill Creator validator against the installed temporary Skill; expect valid frontmatter and structure.
- [ ] Record test evidence in Linear.

### Task 5: Prove the lifecycle with an isolated real Codex turn

**Files:**
- Create: `test/fixtures/codex-graphify-testbot/` only if a persistent fixture is required; otherwise use `/private/tmp`.

- [ ] Install the bundle into a temporary dedicated `CODEX_HOME` and temporary Developer Bot workspace.
- [ ] Run a direct UserPromptSubmit hook probe and capture the injected context.
- [ ] Run official `codex exec` on a code-reading prompt with the reviewed global `CODEX_HOME/hooks.json` trusted in the isolated runtime.
- [ ] Confirm the first attempted standard source-read/edit path is denied before graphify.
- [ ] Confirm the canonical graphify command is rewritten once, exits 0, and creates a receipt bound to the same session+turn+repo.
- [ ] Confirm source read succeeds after graphify and edit remains denied until `affected` succeeds.
- [ ] Confirm no shared graph, production repo, live Bot, or Personal Memory file changes.
- [ ] Record live-test evidence in Linear.

### Task 6: Independent review and corrections

**Files:**
- Review the complete branch diff against this design and ALB-1379 close criteria.

- [ ] Ask Ada for independent review with base SHA, head SHA, requirements, and fresh test evidence.
- [ ] Classify findings as Critical, Important, or Minor.
- [ ] For every Critical/Important finding, add a failing regression test, verify RED, make the smallest fix, and verify GREEN.
- [ ] Re-run Task 4 after corrections.
- [ ] Record review evidence with Critical=0 and Important=0 before proceeding.

### Task 7: Builder integration and deployment gate

**Files:**
- Integrate the reviewed bundle into the ALB-1208 Codex Bot builder role manifest when that builder implementation point is available.

- [ ] Add a builder contract test proving Developer Bot defaults to the graphify bundle and Personal Assistant roles do not inherit the developer gate unless explicitly selected.
  - Contract seam: `scripts/codex-bot-role-bundles.json` + `scripts/install-codex-role-bundles.py`; the full three-entry builder remains ALB-1208 work.
- [ ] Build a fresh isolated Codex Developer testbot from the builder and repeat Task 5.
- [ ] Send Cody the exact candidate, tests, rollback, and required Theo/Ada live-proof sequence.
- [ ] Do not merge, reload, restart, or deploy until Cody explicitly opens the gate.
- [ ] If approved, deploy one Bot at a time, verify no double poller, run Theo and Ada live proof, and retain rollback backups.
- [ ] Ask Albert for acceptance; do not close the parent line before approval.
