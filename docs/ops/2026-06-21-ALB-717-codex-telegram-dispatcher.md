# ALB-717 Codex Telegram Dispatcher Control Pointer

Linear is the control-plane truth. This file is only a local recovery pointer for the isolated TeleCodex/Theo validation line.

- Linear issue: ALB-717
- Parent parity issue: ALB-742
- Latest runtime evidence comments:
  - Telegram reply/voice proof: https://linear.app/albert-yang/issue/ALB-717/codex-dispatcher-native-telegram-ux-parity-typing-reactions#comment-225093af
  - Mailbox proof: https://linear.app/albert-yang/issue/ALB-717/codex-dispatcher-native-telegram-ux-parity-typing-reactions#comment-0198493b
  - Busy queue + voice + typing + reaction proof: Linear comment `36896549-2ab1-4792-a9b1-e5546963831f`
  - Post-review THEO proof at `4bee8f1`: Linear comment `6b1c1ffc-3157-40aa-8f67-5f04c97dc20a`
- Branch: `alb-717-native-telegram-queue`
- Runtime bot: `@albert_v3_xpx_bot`
- Runtime launchd label: `com.albert.albert-v3-codex-dispatcher`
- Runtime repo: `/Users/albertyang0888/code/codex-telegram-research/telecodex`
- Runtime workspace: `/Users/albertyang0888/code/codex-telegram-research/discipline-workspace`
- Final target runtime model/effort: `gpt-5.5` + `xhigh`

2026-06-21 checkpoint:

- Current backend implementation is TeleCodex -> official `@openai/codex-sdk` -> Codex `thread.runStreamed`.
- `CODEX_PATH` is a launch wrapper boundary, not the primary protocol. The live wrapper adds `--ignore-user-config`; start preflight checks AGENTS markers, model, sandbox, approval, token path, allowed user, and mailbox settings.
- Mac mini live Codex runtime path `/opt/homebrew/bin/codex` is `codex-cli 0.141.0` when launched with the TeleCodex PATH. `~/.local/bin/codex` is also installed at 0.141.0 for direct shell use.
- Live preflight with launchd env: `./start-telecodex.sh dry-run --exec-probe` returned `preflight ok` and `discipline_version=ALB-714-hard-discipline-v1`.
- ALB-749 live rollout: launchd env now has `CODEX_REASONING_EFFORT=xhigh`; launch log shows `Default reasoning effort: xhigh`; `/session` proof message `25782` -> `25783` returned `Model: gpt-5.5` and `Reasoning effort: xhigh`.
- Successful voice transcription is internal Dispatcher input only; it must not be sent as a visible Telegram `Transcribed:` message.
- Ordinary Telegram replies default to final answer only: no internal process, no source/link footer, no citation block unless Albert explicitly asks.
- Telegram queue behavior is FIFO per context. It is not CC native `--replay-user-messages` coalescing; it serializes follow-ups after final reply send. Voice messages get a pending queue slot before transcription, so later text stays behind earlier voice.
- Reaction/read behavior is implemented as Telegram reactions: `👀` on receipt/queued and `👍` after successful prompt when `ENABLE_TELEGRAM_REACTIONS=true`.
- Typing behavior is implemented via repeated `sendChatAction("typing")` during transcription and Codex turns.
- Mailbox/bot-to-bot is implemented by TeleCodex `src/mailbox.ts`, not by re-enabling the legacy CC `com.albert.mailbox-waker-albert-v3` tmux waker.
- Mac mini verification after reload: `npm run build`, `npm test -- test/bot.test.ts`, and `npm test` passed.
- Theo live proof:
  - Text message `25644` -> reply `25645`, no visible source/footer/link list.
  - Audio message `25647` -> reply `25648`, final text `听得到，我在。`, no visible transcript.
  - Mailbox message `alb742-live-mailbox-00024e536d94`: `codexprobe -> albert-v3 -> codexprobe` reply `MAILBOX-LIVE-OK-alb742-live-mailbox-00024e536d94`; receipt delivered by `telecodex-mailbox-bridge`.

Current access boundary:

- Live Codex with `--ignore-user-config` can read `code/claude`, `personas`, and the Linear API key path existence under read-only sandbox; key content was not printed.
- Installed Mac mini Codex plugins are not enough to claim runtime connector parity. `codex mcp list` reports no MCP servers configured for live runtime. Use the Linear GraphQL fallback for reliable control-plane writes until connector write behavior is explicitly proven.

Expanded control-plane queue, mirrored from Linear:

- ALB-742: parent CC-bot system connectivity parity audit.
- ALB-716: Codex Connected Dispatcher Bot Agent Skill / build factory.
- ALB-743: standalone Codex Dispatcher Bot specification reference.
- ALB-714 and ALB-698: runtime discipline and proof that discipline is followed, not only loaded.
- ALB-722 and ALB-748: runtime control-plane and external app connector parity for Linear, GitHub, Notion, Figma, Canva, Gmail/email.
- ALB-747: output style / persona parity with CC Theo; no internal self-talk, no visible transcript, no source/footer unless requested.
- ALB-749: runtime model/effort target, eventually `xhigh`, with launch proof.
- ALB-750: direct CC-style cross-persona Telegram send parity; separate from the mailbox proof.
- ALB-700: productionization, launchd/preflight/logs/rollback.
- ALB-745: auth recovery signal lifecycle.

Open items stay in Linear, not here:

- Reaction/read emoji live proof.
- Richer typing/busy UX proof.
- Finish review/closure for Theo's default runtime effort `xhigh`; live rollout proof is on ALB-749.
- Prove or explicitly scope out GitHub/Notion/Figma/Canva/Gmail runtime access from live TeleCodex sessions; tracked by ALB-748 / ALB-722.
- Build the CodexBot Agent Skill after the design/spec has closed; tracked by ALB-716.
- Validate runtime discipline end to end on THEO/testboard; tracked by ALB-714 / ALB-698.
- GitHub branch/PR sync and Albert acceptance before closing ALB-717.

2026-06-22 ALB-833 Memory transcript sink addendum:

- ALB-833 root cause: the live `com.albert.albert-v3-codex-dispatcher` runtime was a TeleCodex/Codex dispatcher, not the old Channels wrapper, so Graphiti had no proven `TRANSCRIPT_ROOT` lane for `albert-v3` source Sessions.
- Implementation boundary: TeleCodex still does not read/query Memory. It only has an optional write sink enabled by `TRANSCRIPT_ROOT`.
- Contract: `TRANSCRIPT_ROOT` must be an absolute source persona `memory/Sessions` directory. `MEMORY_TRANSCRIPT_ROOT` is intentionally not accepted, matching the Memory health check contract.
- Runtime target for THEO/albert-v3: `TRANSCRIPT_ROOT=/Users/albertyang0888/personas/albert-v3/memory/Sessions`.
- Output format: append-only `YYYY-MM-DD.md` blocks tagged `[user-raw]` and `[bot-raw]` with `message_id`, `context_key`, and `thread_id` metadata comments. Graphiti owns owner routing and lane markers.
- This does not close ALB-833 until the launchd env is deployed, live Telegram proof creates a source Sessions turn, health reports `codex_dispatcher_memory_lane OK`, and the next Graphiti ingest advances `.graphiti_session_state.albert-v3.json`.

ALB-714 discipline mirror:

- The Codex developer discipline must require root-cause fixes, not downstream symptom patches.
- For any bug or operational failure, Codex must explain why the issue could happen in the first place and place the fix at the earliest reliable boundary: tooling, config, protocol, API contract, or dispatcher layer.
- Workarounds are allowed only as explicitly labeled temporary containment and must have a Linear follow-up. They are not closure evidence.
- Closure needs red/green tests where code behavior changed, runtime/live evidence, review, and Linear comments. Loading these words in `AGENTS.md` is not enough; ALB-714 / ALB-698 still need THEO end-to-end discipline lifecycle proof.
- 2026-06-22 root-cause update: `AGENTS.md` alone is not enough for existing long-running Telegram threads. TeleCodex now injects a short `[DEVELOPER DISCIPLINE]` block per turn at the existing prompt seam and strips exact injected guard echoes from final/streaming Telegram output.

2026-06-22 live proof addendum:

- Runtime branch: `alb-717-native-telegram-queue`.
- Runtime launchd state: `com.albert.albert-v3-codex-dispatcher` running, pid `64147`, last exit `(never exited)`.
- Runtime env proof: `CODEX_MODEL=gpt-5.5`, `CODEX_REASONING_EFFORT=xhigh`, `VOICE_TRANSCRIPTION_BACKEND=qwen`, `ENABLE_TELEGRAM_REACTIONS=true`, `STREAM_AGENT_RESPONSES=false`.
- Fresh Mac mini verification:
  - `npm test -- --run test/bot.test.ts test/voice.test.ts`: 73 tests passed.
  - `npm run build`: `tsc` passed.
  - `npm test`: 19 files / 290 tests passed.
- Isolated ASR probe:
  - Generated `/tmp/alb717_voice_probe.ogg`.
  - Qwen via `dist/voice.js` returned `阿尔伯特，忙时语音队列验证，请回复 Voice Queue OK。`, backend `qwen`, duration `459ms`.
- Live THEO proof via Pyrogram against `@albert_v3_xpx_bot`:
  - Nonce: `ALB717_20260622T061200Z`.
  - Sent sequence while first turn was busy: long text requiring real `sleep 25`, then queued text, queued voice, queued text.
  - Replies arrived in order: `ALB717_20260622T061200Z_FIRST_DONE`, `ALB717_20260622T061200Z_TEXT1_DONE`, `Voice Queue OK`, `ALB717_20260622T061200Z_TEXT2_DONE`.
  - Captured 13 raw Telegram typing updates.
  - Captured reaction snapshots moving through receipt and completion states; final queued text/voice snapshots reached thumbs-up.
  - `contains_transcript_echo=false`; the voice transcript was not emitted as a standalone visible Telegram message.
  - Full JSON: `/tmp/alb717_live_probe_result.json` on Mac mini.
- Log note: old `getUpdates 409 Conflict` entries are stale; `telecodex.launchd.err.log` mtime was before current pid start, process check found only one TeleCodex node, and the live proof succeeded after that log timestamp.

2026-06-22 post-review live proof addendum:

- Runtime commit: `4bee8f1` on branch `alb-717-native-telegram-queue`.
- Runtime launchd state: `com.albert.albert-v3-codex-dispatcher` running, pid `98004`, last exit `0`.
- Runtime env proof: `CODEX_MODEL=gpt-5.5`, `CODEX_REASONING_EFFORT=xhigh`, `VOICE_TRANSCRIPTION_BACKEND=qwen`, `ENABLE_TELEGRAM_REACTIONS=true`, `STREAM_AGENT_RESPONSES=false`.
- Fresh THEO live nonce: `ALB717R2_20260622T064800Z`.
- Sent sequence while first turn was busy: long text `25913`, queued text `25914`, queued voice `25915`, queued text `25916`.
- Replies arrived FIFO: `ALB717R2_20260622T064800Z_FIRST_DONE`, `ALB717R2_20260622T064800Z_TEXT1_DONE`, `audio okay.`, `ALB717R2_20260622T064800Z_TEXT2_DONE`.
- Captured 12 typing updates; all four source messages ended with `👍`; `contains_transcript_echo=false`.
- Direct Qwen ASR check for `/tmp/alb717_voice_probe2.ogg` returned `Please reply audio. Okay.` before the live run.
- Full JSON: `/tmp/alb717_live_probe_after_restart_result.json` on Mac mini.
- Both local and Mac mini TeleCodex repos were clean at `4bee8f1` after proof capture.

2026-06-22 ALB-714 per-turn discipline proof:

- Code commit: `1274ab6 Refs ALB-714 inject dispatcher discipline per turn`.
- Root cause: runtime `AGENTS.md` is a new-session/project baseline, but the active THEO Telegram context is a long-running Codex thread; updated exact discipline text is not guaranteed to be present in that thread. The earliest reliable boundary for Telegram runtime enforcement is the existing TeleCodex per-turn prompt preamble.
- Implementation:
  - `src/bot.ts` adds `[DEVELOPER DISCIPLINE]` to every text/object prompt, including text, voice transcript, document staged instructions, image prompts, and queued prompts.
  - The block includes exact `discipline_version=ALB-714-hard-discipline-v1`, Linear-first, Superpowers/TDD/review/verification, root-cause earliest-boundary rule, workaround Linear follow-up, subagent verification, and no-Memory boundary.
  - Output path strips exact injected prompt guard echoes from final replies and streaming previews, including quote/list/inline-code/bold decorated forms.
- TDD / review evidence:
  - Red tests first: developer discipline injection for text/voice, output no-leak for final/streaming replies, document/image/queued prompt coverage, markdown-decorated guard echo leak cases.
  - Reviewer found two rounds of Important no-leak gaps; both were fixed. Final review found no Critical/Important findings.
  - Mac mini verification: `npm test -- --run test/bot.test.ts` -> 47 tests passed; `npm run build` -> passed; `npm test` -> 19 files / 304 tests passed.
- Runtime rollout:
  - Mac mini repo clean at `1274ab6`.
  - `dist/bot.js` contains `[DEVELOPER DISCIPLINE]` and `ALB-714-hard-discipline-v1`.
  - launchd restarted from pid `98004` to pid `16835`; env remains `CODEX_MODEL=gpt-5.5`, `CODEX_REASONING_EFFORT=xhigh`, `STREAM_AGENT_RESPONSES=false`, `ENABLE_TELEGRAM_REACTIONS=true`.
- THEO live proof via Pyrogram:
  - Version probe file: `/tmp/alb714-turn-discipline-version-live-20260622T0726.json`.
  - Sent id `25946`, reply id `25947`, final reply `ALB-714-hard-discipline-v1`.
  - No-leak probe file: `/tmp/alb714-turn-discipline-noleak-live-20260622T0730.json`.
  - Sent id `25949`, reply id `25950`, final reply `ALB714_NOLEAK_OK`; hidden guard lines were not visible in Telegram.
- ALB-714 still should not close solely from this injection proof. Remaining closure is a real THEO task lifecycle proving Linear-first behavior, root-cause-first repair, TDD/review/live proof, and Albert acceptance.
