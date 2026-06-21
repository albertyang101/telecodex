# ALB-717 Codex Telegram Dispatcher Control Pointer

Linear is the control-plane truth. This file is only a local recovery pointer for the isolated TeleCodex/Theo validation line.

- Linear issue: ALB-717
- Parent parity issue: ALB-742
- Latest runtime evidence comments:
  - Telegram reply/voice proof: https://linear.app/albert-yang/issue/ALB-717/codex-dispatcher-native-telegram-ux-parity-typing-reactions#comment-225093af
  - Mailbox proof: https://linear.app/albert-yang/issue/ALB-717/codex-dispatcher-native-telegram-ux-parity-typing-reactions#comment-0198493b
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
