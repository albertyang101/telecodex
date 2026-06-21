# ALB-717 Codex Telegram Dispatcher Control Pointer

Linear is the control-plane truth. This file is only a local recovery pointer for the isolated TeleCodex/Theo validation line.

- Linear issue: ALB-717
- Latest runtime evidence comment: https://linear.app/albert-yang/issue/ALB-717/codex-dispatcher-native-telegram-ux-parity-typing-reactions#comment-225093af
- Branch: `alb-717-native-telegram-queue`
- Runtime bot: `@albert_v3_xpx_bot`
- Runtime launchd label: `com.albert.albert-v3-codex-dispatcher`
- Runtime repo: `/Users/albertyang0888/code/codex-telegram-research/telecodex`
- Runtime workspace: `/Users/albertyang0888/code/codex-telegram-research/discipline-workspace`
- Final target runtime model/effort: `gpt-5.5` + `xhigh`

2026-06-21 checkpoint:

- Successful voice transcription is internal Dispatcher input only; it must not be sent as a visible Telegram `Transcribed:` message.
- Ordinary Telegram replies default to final answer only: no internal process, no source/link footer, no citation block unless Albert explicitly asks.
- Mac mini verification after reload: `npm run build`, `npm test -- test/bot.test.ts`, and `npm test` passed.
- Theo live proof:
  - Text message `25644` -> reply `25645`, no visible source/footer/link list.
  - Audio message `25647` -> reply `25648`, final text `听得到，我在。`, no visible transcript.

Open items stay in Linear, not here:

- Reaction/read emoji live proof.
- Richer typing/busy UX proof.
- Make Theo's default runtime effort `xhigh` using the native Codex reasoning-effort path; do not add a separate glue layer.
- GitHub branch/PR sync and Albert acceptance before closing ALB-717.
