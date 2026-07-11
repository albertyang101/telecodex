# ALB-1201 Linear + HANDOFF Ecosystem Proof

Date: 2026-07-11 AEST
Candidate: alb-1201-linear-handoff-ecosystem
Base: 4326bb3
Head: 230c1a9

## Scope proved in isolation

- Full Linear lifecycle contract is injected on every TeleCodex Telegram and mailbox turn.
- Rotation HANDOFF carries stable, deduplicated Linear issue references from recent turns, unanswered messages, and the interrupted breakpoint.
- A context-pressure mailbox timeout keeps the original message unread and automatically retries it once on a fresh thread; a second timeout uses the existing quarantine path.
- Every newborn role receives the core Linear/HANDOFF UserPromptSubmit hook.
- Developer additionally receives graphify; Albert Personal and Family Personal do not.
- No Memory, Graphiti, or persona-memory connector is installed.

## Red evidence

- Linear per-turn contract: 21 focused tests, 2 expected failures.
- HANDOFF Linear references: 53 focused tests, 2 expected failures.
- Mailbox automatic resume: 72 focused tests, 3 expected failures.
- Newborn core bundle: 14 focused tests, 6 expected failures.
- Existing graphify-only Developer upgrade: 9 focused tests, 1 expected failure.

All failures were caused by the missing behavior under test, not syntax or environment errors.

## Green evidence

Fresh final verification:

- Python compile: exit 0 for the three changed installer/hook scripts.
- `npm test -- --run`: 38 files, 695 tests passed, 0 failed.
- `npm run build`: exit 0.

Newborn role proof ran each installer twice in fresh temporary directories:

- developer: core-discipline + graphify; byte-idempotent; core hook executes; Memory negative.
- albert-personal: core-discipline only; byte-idempotent; graphify absent; Memory negative.
- family-personal: core-discipline only; byte-idempotent; graphify absent; Memory negative.
- Temporary proof directories were removed after the run.

## Safety and rollback

- No production runtime, bot token, poller, supervisor, or production repository was changed.
- Unknown existing hooks fail closed before any partial installation.
- Known graphify-only managed Developer hooks can upgrade to the combined core + graphify document.
- Runtime rollback remains the previous build plus `CODEX_AUTO_ROTATE=false` for rotation stop-the-bleed.

## Not yet proved

- Ada independent review is requested and pending.
- A real disposable Telegram Testbot has not yet run the complete Linear lifecycle through a forced live thread rotation.
- Theo and Ada production rollout/live proof are blocked by the existing Cody deployment freeze and require the normal no-double-poller gate.
- Parent issue remains open for Albert approval.
