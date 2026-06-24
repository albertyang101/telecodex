# ALB-917 Codex Developer Bot Control Mirror

Linear is the source of truth. This file is a local recovery pointer for the active Codex Telegram Dispatcher line.

## Control Plane

- ALB-917: disposable E2E testbot live build and runtime proof.
- ALB-716: reusable Agent Skill for creating Codex-connected Dispatcher/developer bots.
- ALB-743: standalone Codex Dispatcher bot specification.
- ALB-714 / ALB-698: discipline enforcement and lifecycle validation.

## Current Runtime

- Testbot: `albert_codex_e2e_4ad0_bot`.
- Launchd label: `com.albert.albert-codex-e2e-codex-dispatcher`.
- Workspace: `/Users/albertyang0888/code/codex-telegram-research/albert-codex-e2e-workspace`.
- Backend: TeleCodex thin dispatcher adapter to official Codex CLI/SDK.
- Target default: `gpt-5.5` with `xhigh` reasoning effort.
- Memory/Graphiti/personal memory: out of scope.
- THEO/theu: Albert-owned bot; do not use for this validation.

## Verified Evidence

- Unit/build before post-build restart: `npm test` and `npm run build -- --pretty false` passed on Mac mini.
- Long input live proof: `/tmp/alb917-long-input-result.json`, final `ALB917_LONG_INPUT_OK`.
- Long output live proof: `/tmp/alb917-long-output-result.json`, multi-message Telegram output preserved start/end markers.
- Voice live proof: `/tmp/alb917-whisper-live-result.json`, final `阿尔伯特语音验证通过。`, no transcript leakage.
- Busy voice live proof: `/tmp/alb917-busy-whisper-live-result.json`, queued after active turn and replied successfully.
- Focused live smoke after latest build/restart: Linear comment `c2f51bb3-41a3-4378-8afb-af1936ea5e8d`, JSON `/tmp/alb717-reviewfix-followup-live.json`, nonce `ALB717_REVIEWFIX_20260624T1109`, single final reply `ALB717_REVIEWFIX_20260624T1109_OK`, no stale first-turn completion, no visible timeout.
- Direct Codex hard-discipline lifecycle proof in the isolated testbot workspace: ALB-714 main verification comment `bbc603f2-12c0-4035-9199-f77073859497`, ALB-917 status comment `86a962d8-e0e8-43cb-9063-097fe1a8d000`, fixture `discipline-lifecycle-probe/alb714-live-discipline-20260624T1130`, Linear evidence START `759b6e15-4aef-4469-80b9-dcfaa432f748`, GREEN `7462a05a-080b-4aa6-a0cd-b22819fbc1ad`, log `/tmp/alb714-lifecycle-direct.log`, independent rerun `python3 -m pytest -q` -> 2 passed.
- Telegram-path Codex hard-discipline lifecycle proof: ALB-714 comment `cd2e7c7f-373c-4412-8a87-481834893a87`, ALB-917 comment `439a7eb5-2ffb-48ba-a3b2-258d03fedcdc`, fixture `discipline-lifecycle-probe/alb714-telegram-discipline-20260624T1145`, bot reply message `27692` with `ALB714_TELEGRAM_LIFECYCLE_20260624T1145_DONE red_green_linear_ok`, runtime-written Linear evidence START `24a5f701-f866-4f4b-b67d-ea9d0ad881d7`, RED `8522c124-3c4d-4073-85a0-a911aa985ff2`, GREEN `4acff552-ba47-4c75-bed4-ab463348451f`, independent rerun `python3 -m pytest -q` -> 2 passed.
- Agent Skill checkpoint: ALB-716 comment `66c17408-9c3a-4839-a43e-61672a627063`, ALB-917 comment `f6d1a1ca-126c-4d0a-90cc-add48f5b32af`; CC repo has an untracked draft at `templates/global-skills/build-codex-dispatcher-bot/SKILL.md` plus metadata tests at `tests/test_build_codex_dispatcher_bot_skill.py`; targeted verification on Mac mini `PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -q tests/test_build_codex_dispatcher_bot_skill.py` -> 10 passed. It is not committed from the CC repo because `/Users/albertyang0888/code/claude` is heavily dirty with parallel Dispatcher/Memory WIP.
- Self-recovery checkpoint: ALB-810 comment `359cd987-281f-4ade-811d-bab2603cb01a`; fresh Mac mini verification `npm test -- test/process-lifecycle.test.ts test/shutdown.test.ts test/polling.test.ts test/mailbox.test.ts test/codex-session.test.ts --reporter=dot` -> 5 files / 81 tests passed, `npm run build` passed.
- Bot API/polish status corrected after retry: `getWebhookInfo.pending_update_count=0`; `getMe` returns `Albert Codex Dev` / `@albert_codex_e2e_4ad0_bot`. Earlier Pyrogram timeout root cause was the wrong copied session (`/Users/albertyang0888/code/claude/state/test_probe.session`, `user_id=0`); the CC-native Pyrogram path is `/Users/albertyang0888/personas/albert/.claude/.secrets/tg_user.session` with `Client("tg_user", api_id=28548788, api_hash="placeholder", workdir=...)`, verified by `get_me` returning user id `6872058088`.
- Poller-stall evidence for ALB-810: comment `66cc4872-da3c-46e2-a3b6-367a14dfd2ba`; launchd job was alive while Bot API showed `pending_update_count=3`, then a controlled kickstart of only `com.albert.albert-codex-e2e-codex-dispatcher` preserved and consumed the updates. This is a remaining self-recovery gate, not a closed stability claim.
- Poller-stall watchdog implementation checkpoint: Linear ALB-810 comment `e40a28f3-63d5-4a4e-a06f-cdf99e415055`, ALB-917 comment `e2bc9612-97ff-4a97-a82b-b4c82a027219`; `src/polling.ts` now detects sustained Telegram `pending_update_count` while the grammY runner is alive with no in-flight middleware, stops that polling handle, and restarts polling without `drop_pending_updates`; `test/polling.test.ts` covers restart-on-stall, no-restart-while-runner-busy, and no-drop-on-watchdog-restart after an explicit clean startup. Review found one Important drop-risk in the first implementation; red test reproduced the second `deleteWebhook` incorrectly keeping `{ drop_pending_updates: true }`, then the fix changed drop behavior to first polling start only. Verification after review fix: local `npm test -- test/polling.test.ts --reporter=dot` -> 9 passed, local `npm run build` passed, local full `npm test -- --reporter=dot` -> 25 files / 519 tests passed; Mac mini targeted -> 9 passed, build passed, full -> 27 files / 524 tests passed. Deployed to disposable testbot by rebuilding and kickstarting only `com.albert.albert-codex-e2e-codex-dispatcher`; live smoke `/tmp/alb810-watchdog-reviewfix-smoke.json`, `27701 -> 27702`, final `ALB810_WATCHDOG_REVIEWFIX_20260624T1232_OK`, Bot API pending 0.
- Runtime Superpowers skill-body install: ALB-714 comment `6bd01828-c2d9-4c66-b3a2-4b6211fdefc4`, ALB-917 comment `f5c2bf90-7c2d-4ed5-a824-011fd793c02c`; dedicated testbot `CODEX_HOME` now has `using-superpowers`, `systematic-debugging`, `test-driven-development`, `requesting-code-review`, `verification-before-completion`, and `linear` under `.codex-runtime-home/skills`; `./start-telecodex.sh dry-run --exec-probe` returned `discipline_version=ALB-714-hard-discipline-v1` and `exec_probe=ok`.
- Runtime skills install live smoke: ALB-714 comment `55d4971e-f607-4fc4-af83-c6d6b910d623`, ALB-917 comment `f3ea560a-683a-483a-b6f8-18893fd399dd`; `/tmp/alb714-skills-install-smoke.json`, `27709 -> 27710`, final `ALB714_SKILLS_INSTALL_SMOKE_20260624T1242_OK`, Bot API pending 0, local branch clean at `9850a55`.
- Bot polish evidence: ALB-917 comment `a8a1bbe2-37a9-4de3-ad43-5872ce838c04`; Bot API `getMe` returns `Albert Codex Dev` / `@albert_codex_e2e_4ad0_bot`; commands, description, and short description are registered; BotFather/Pyrogram set avatar from `theo_avatar_v2.png`, BotFather returned success, `getUserProfilePhotos.total_count=1`, Bot API pending 0.
- Official plugin install checkpoint: ALB-917 comment `761f63af-71ae-4358-a1f8-02c2adbb09f1`, ALB-716 comment `8d54d619-74be-429b-b336-4e5fd5ef4638`; installed/enabled `linear`, `github`, `notion`, `gmail`, `canva`, and `superpowers` from `openai-curated` into the testbot dedicated `CODEX_HOME`; dry-run exec probe still passed; live smoke `/tmp/alb917-plugin-install-smoke.json`, `27719 -> 27720`, final `ALB917_PLUGIN_INSTALL_SMOKE_20260624T1248_OK`, Bot API pending 0. Figma intentionally skipped per Albert's latest priority call.
- Natural-language skill fire probe: ALB-714 comment `6c87f586-6d5e-48d5-bdc6-4611088b573d`, ALB-917 comment `18957fed-b2ae-4142-b074-da3d82d1a320`, ALB-716 comment `0537f76c-3225-4524-a67c-ba40a95a0505`; direct Codex runtime marker `ALB917_SKILL_FIRE_DIRECT_20260624T1252`, exit 0, `/tmp/alb917-skill-fire-direct.txt` final `ALB917_SKILL_FIRE_DIRECT_20260624T1252_OK`, and `/tmp/alb917-skill-fire-direct.log` contains loaded `verification-before-completion` skill text.
- GitHub runtime read probe: ALB-917 comment `a3daa2e8-c814-4436-8c30-6aa8781c00cd`, ALB-716 comment `5289914f-eeaa-43fa-ae2a-7ea1e3507f6b`; direct Codex runtime marker `ALB917_GITHUB_READ_PROBE_20260624T1256`, exit 0, final `ALB917_GITHUB_READ_PROBE_20260624T1256_OK b7e193a`; log shows GitHub plugin skill loaded and `codex_apps/github.compare_commits` completed; host `gh auth status` is logged in as `albertyang101` with repo scope.

## Open Gates

- Convert the validated testbot into a complete Codex developer bot comparable to THEO.
- Land and validate the Codex developer bot Agent Skill safely: no CC WIP collision, skill TDD/pressure scenarios, then sync/commit only after evidence.
- Continue ALB-810 broader stability matrix: longer soak for the poller-stall watchdog, stuck in-flight live turn under short timeout, upstream rate/cap degradation handling, Telegram user injection reliability, and longer soak for the new testbot profile.
- Do not detour into mailbox redesign in ALB-917; keep mailbox WIP in place.
