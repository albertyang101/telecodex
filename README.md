# TeleCodex

TeleCodex is a Telegram bridge for the OpenAI Codex CLI SDK. It keeps a Codex thread alive from your phone, streams agent responses and tool output in real time, and lets you hand the thread back to the CLI whenever you want.

## Features

- **Per-context sessions** — each Telegram chat or forum topic gets its own independent Codex session with separate thread, model, and busy state
- **Streaming responses** — agent text edits in-place as Codex generates it
- **Full tool visibility** — shell commands, file changes, web searches, MCP calls, and error items shown with configurable verbosity
- **Live plan display** — Codex's todo list rendered as a separate message and updated as steps complete
- **Voice transcription** — send a voice message or audio file; TeleCodex transcribes it with a configured backend (Qwen3-ASR resident server, parakeet-coreml, or OpenAI transcription) and forwards the text to Codex
- **Image input** — send a photo (with optional caption) to pass screenshots or images directly to Codex
- **File ingest & artifacts** — send a document to stage it for Codex; generated files are delivered back as Telegram documents
- **Session browser** — `/sessions` lists recent threads from `~/.codex`, grouped by workspace; tap to switch
- **Telegram login** — `/login` authenticates against the Codex CLI via device auth flow, no terminal needed
- **Launch profiles** — `/launch_profiles` selects the sandbox + approval mode for new or reattached threads in the current Telegram context (`/launch` remains an alias)
- **Model picker** — `/model` shows available models and lets you switch for new threads
- **Reasoning effort** — `/effort` lets you dial from `minimal` to `xhigh` for new threads
- **Optional message reactions** — 👀 while processing, 👍 on success when enabled; silently degrades in chats without reaction support
- **Friendly errors** — common SDK and network errors are translated to actionable messages with command hints
- **Token usage** — session token totals shown on `/session`, with optional per-turn footer in replies
- **Handback flow** — `/handback` prints a ready-to-run `codex resume <id>` command (copied to clipboard on macOS)
- **User allowlist** — only configured Telegram user IDs can interact with the bot
- **Docker-friendly** — workspace auto-detected (`/workspace` in containers, `cwd` otherwise)

## Prerequisites

- Node.js 22+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The Codex CLI installed and authenticated on the host:
  - API key auth: set `CODEX_API_KEY`
  - ChatGPT login: `codex login` on the machine, or use `/login` from Telegram
- *(Optional)* Qwen3-ASR resident server — recommended for Chinese voice; set `VOICE_TRANSCRIPTION_BACKEND=qwen` and `QWEN_ASR_SOCKET=/tmp/qwen_asr.sock`
- *(Optional)* `ffmpeg` — required for local voice transcription via parakeet-coreml
- *(Optional)* `OPENAI_API_KEY` — enables OpenAI transcription fallback

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs |
   | `CODEX_API_KEY` | — | API key for Codex (alternative to ChatGPT login) |
   | `CODEX_MODEL` | — | Default model, e.g. `gpt-5.4`, `o3` |
   | `CODEX_REASONING_EFFORT` | — | Default reasoning effort for new threads: `minimal`, `low`, `medium`, `high`, or `xhigh` |
   | `CODEX_TURN_TIMEOUT_MS` | — | Optional foreground Telegram turn lease in milliseconds; on timeout TeleCodex aborts the current Codex turn, sends a timeout reply, and drains queued follow-ups. Unset by default. |
   | `CODEX_TURN_ABORT_GRACE_MS` | — | Optional post-timeout grace in milliseconds; if the aborted turn still has not settled after this grace, TeleCodex fails loud so launchd can restart it. Requires `CODEX_TURN_TIMEOUT_MS`. |
   | `CODEX_SANDBOX_MODE` | — | `read-only`, `workspace-write` *(default)*, `danger-full-access` |
   | `CODEX_APPROVAL_POLICY` | — | `never` *(default)*, `on-request`, `on-failure`, `untrusted` |
   | `CODEX_LAUNCH_PROFILES_JSON` | — | Optional JSON array of named launch profiles for `/launch_profiles` |
   | `CODEX_DEFAULT_LAUNCH_PROFILE` | — | Default launch profile id (defaults to `default`) |
   | `ENABLE_UNSAFE_LAUNCH_PROFILES` | — | Set to `true` to allow extra `danger-full-access` launch profiles |
   | `TOOL_VERBOSITY` | — | `all`, `summary`, `errors-only`, `none` *(default)* |
   | `SHOW_TURN_TOKEN_USAGE` | — | Show the per-turn `in/cached/out` footer in final replies (`false` by default) |
   | `MAX_FILE_SIZE` | — | Max upload size in bytes (default `20971520` = 20 MB) |
   | `ENABLE_TELEGRAM_LOGIN` | — | Allow `/login` and `/logout` from Telegram (`true` by default) |
   | `ENABLE_TELEGRAM_REACTIONS` | — | Enable Telegram emoji reactions like 👀 / 👍 (`false` by default) |
   | `TRANSCRIPT_ROOT` | — | Optional absolute path to a Graphiti-readable source `memory/Sessions` directory. When set, TeleCodex appends final user/assistant turns as `[user-raw]` / `[bot-raw]` markdown for Albert Memory ingest. |
   | `TELEGRAM_TRANSPORT_MCP_ENABLED` | — | Enable the CC-style `telegram_transport` MCP server for direct cross-persona Telegram sends (`false` by default) |
   | `TELEGRAM_TRANSPORT_MCP_AUTO_APPROVE_SENDS` | — | Auto-approve the direct Telegram send MCP tool for non-interactive dispatcher runs. This can post real Telegram messages; keep `false` unless the runtime is isolated and explicitly allowed. |
   | `TELEGRAM_TRANSPORT_MCP_SERVER_NAME` | — | MCP server name injected into Codex CLI (default `telegram_transport`) |
   | `TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH` | — | Path to `{chat_id: persona_name}` mapping, default `~/code/claude/state/personas.json` |
   | `TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES` | — | Comma-separated persona prefixes blocked from direct sends (default `dadamia_`) |
   | `TELEGRAM_TRANSPORT_MCP_STARTUP_TIMEOUT_MS` | — | MCP server startup timeout in milliseconds (default `10000`) |
   | `TELEGRAM_TRANSPORT_MCP_TOOL_TIMEOUT_MS` | — | MCP tool call timeout in milliseconds (default `30000`) |
   | `LINEAR_CONTROL_MCP_ENABLED` | — | Enable the scoped Albert Linear control MCP server (`false` by default) |
   | `LINEAR_CONTROL_MCP_SERVER_NAME` | — | MCP server name injected into Codex CLI (default `linear_control`) |
   | `LINEAR_CONTROL_MCP_AUTO_APPROVE_EVIDENCE` | — | Auto-approve only the typed `add_linear_evidence` tool for unattended control-plane evidence writes. Keep the issue allowlist narrow. |
   | `LINEAR_CONTROL_ALLOWED_ISSUES` | — | Comma-separated allowlist of writable Albert Linear issue identifiers, e.g. `ALB-714,ALB-722` |
   | `LINEAR_API_KEY_PATH` | — | Absolute path to a Linear API key file. Raw `LINEAR_API_KEY` is not passed into Codex child processes. |
   | `LINEAR_CONTROL_MCP_STARTUP_TIMEOUT_MS` | — | Linear control MCP server startup timeout in milliseconds (default `10000`) |
   | `LINEAR_CONTROL_MCP_TOOL_TIMEOUT_MS` | — | Linear control MCP tool call timeout in milliseconds (default `30000`) |
   | `VOICE_TRANSCRIPTION_BACKEND` | — | Voice backend: `auto`, `qwen`, `parakeet`, or `openai` (`auto` by default) |
   | `VOICE_TRANSCRIPTION_TIMEOUT_MS` | — | Local/parakeet decode, initialization, and transcription timeout in milliseconds (default `270000`) |
   | `QWEN_ASR_SOCKET` | — | Unix socket for the Qwen3-ASR resident server, e.g. `/tmp/qwen_asr.sock` |
   | `QWEN_ASR_CONTEXT` | — | Optional Qwen3-ASR context/hotword prompt for names and domain terms |
   | `QWEN_ASR_LANGUAGE` | — | Optional Qwen3-ASR language hint |
   | `QWEN_ASR_TIMEOUT_MS` | — | Qwen3-ASR socket timeout in milliseconds (default `270000`) |
   | `TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS` | — | Telegram media download timeout in milliseconds (default `60000`) |
   | `MAILBOX_PROMPT_TIMEOUT_MS` | — | Optional mailbox Codex turn lease in milliseconds; on timeout the bridge aborts the turn, keeps the inbox file unread for inspection, and marks it `failed_prompt_timeout` so later mailbox messages can continue |
   | `OPENAI_API_KEY` | — | Enables OpenAI voice transcription |
   | `OPENAI_TRANSCRIPTION_MODEL` | — | OpenAI transcription model (default `gpt-4o-transcribe`) |
   | `OPENAI_TRANSCRIPTION_TIMEOUT_MS` | — | OpenAI transcription request timeout in milliseconds (default `120000`) |

4. Start the bot:
   ```bash
   npm run dev
   ```

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome & status (concise for returning users) |
| `/help` | Grouped command reference |
| `/new` | Start a fresh thread (workspace picker if multiple workspaces) |
| `/session` | Current thread ID, workspace, model, effort, and token totals |
| `/sessions` | Browse recent threads grouped by workspace; tap to switch |
| `/switch <id>` | Switch directly to a thread by ID |
| `/retry` | Resend the last prompt |
| `/abort` | Cancel the current turn |
| `/launch_profiles` | Select launch profile for new or reattached threads (`/launch` alias kept) |
| `/model` | View and change the model |
| `/effort` | Set reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` |
| `/auth` | Check authentication status |
| `/login` | Start Codex device-auth flow from Telegram |
| `/logout` | Sign out of Codex |
| `/voice` | Check voice transcription backend status |
| `/handback` | Print `codex resume <id>` for CLI handoff |
| `/attach <id>` | Bind an existing Codex thread to this forum topic |

### Voice, image & file input

- **Voice / audio** — send any voice message or audio file; TeleCodex transcribes it and sends the result to Codex. For Chinese production use, prefer `VOICE_TRANSCRIPTION_BACKEND=qwen` with the resident Qwen3-ASR socket; parakeet-coreml is not the Chinese-accuracy path.
- **Photos** — send a photo with an optional caption; the image is forwarded to Codex as visual input
- **Documents** — send a file (with optional caption); TeleCodex stages it in the workspace, runs Codex, and delivers any generated files back as Telegram documents

### Tool verbosity

| Mode | What you see |
|---|---|
| `all` | Every tool start, streaming output, and result |
| `summary` | A short grouped footer such as `Tools used: 3x bash, 2x subagents, web_fetch` |
| `errors-only` | Only failed tool calls |
| `none` *(default)* | Silent |

Per-turn token usage is hidden by default. Set `SHOW_TURN_TOKEN_USAGE=true` if you want the `in / cached / out` footer appended to final replies.

### Launch profiles

- TeleCodex always provides a built-in `default` profile synthesized from `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY`
- Built-in Telegram-visible presets are:
  - `Default`
  - `Read Only`
  - `Review`
  - `Full Access` when `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- `Workspace Write` is not listed separately because it is already the default behavior in the shipped config
- Optional extra profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`, for example:
  ```json
  [
    { "id": "readonly", "label": "Read Only", "sandboxMode": "read-only", "approvalPolicy": "never" },
    { "id": "review", "label": "Review", "sandboxMode": "workspace-write", "approvalPolicy": "on-request" }
  ]
  ```
- `/launch_profiles` changes only future thread creation or reattachment in the current chat/topic context; it does not mutate an already active thread in place
- Extra `danger-full-access` profiles are blocked unless `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Selecting a `danger-full-access` profile from Telegram requires an explicit confirmation step

## Multi-Session Architecture

Each Telegram chat or forum topic is identified by a **context key** — the chat ID alone for private chats, or `chatId:threadId` for forum topics. This means every topic in a supergroup gets its own independent Codex session.

The `SessionRegistry` maps context keys to `CodexSessionService` instances:

```
┌───────────────────┐      ┌───────────────────────────────┐
│ Private Chat A     │─────▶│ CodexSessionService (thread X) │
│ key: "111"         │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 1  │─────▶│ CodexSessionService (thread Y) │
│ key: "222:1"       │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 2  │─────▶│ CodexSessionService (thread Z) │
│ key: "222:2"       │      └───────────────────────────────┘
└───────────────────┘
```

- **First message** in a context → creates a new `CodexSessionService` → starts a new Codex thread
- **Subsequent messages** → same context key → same session → conversation continues
- **`/new`** → replaces the thread within the same context (optionally picking a workspace first)
- **`/sessions`** → lists all Codex threads from `~/.codex`, lets you switch within the current context
- **`/attach <id>`** → resumes a specific Codex CLI thread (useful for picking up work started in the terminal)

Session metadata (thread ID, workspace, launch profile, model, effort) is persisted to `.telecodex/contexts.json` and restored on restart so threads survive bot reboots.

Each context has independent busy-state tracking, so a running prompt in one topic doesn't block another.

## Optional Memory Transcript Sink

TeleCodex does not read or query Albert Memory. When `TRANSCRIPT_ROOT` is set to an absolute source `memory/Sessions` directory, it appends only the visible Telegram user turn and final assistant reply to `YYYY-MM-DD.md` using the existing Graphiti session format:

```md
## HH:MM:SS [user-raw]
<!-- message_id=<chat>:<message>; context_key=<context>; thread_id=<codex-thread> -->
<user text>

## HH:MM:SS [bot-raw]
<!-- message_id=<chat>:<message>; context_key=<context>; thread_id=<codex-thread> -->
<assistant text>
```

For aliased Albert bots, point this to the source persona directory, for example `/Users/albertyang0888/personas/albert-v3/memory/Sessions`. The Graphiti ingest layer owns the source-to-owner routing and lane markers.

## Handoff: Telegram → CLI

1. Run `/handback` in Telegram
2. TeleCodex replies with:
   ```bash
   cd '/path/to/project' && codex resume 'thread-abc123'
   ```
3. Paste and run in your terminal

On macOS the command is also copied to the clipboard automatically.

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
        SessionRegistry  ──→  per-context CodexSessionService instances
                |
                ├── @openai/codex-sdk  ──→  spawns Codex CLI subprocess
                │     └── ThreadEvents (agent text, commands, file changes,
                │                       MCP calls, web searches, todo lists,
                │                       reasoning, errors, token usage)
                ├── TelegramTransportMCP ─→ direct cross-persona send_message
                │                         using state/personas.json
                ├── CodexStateReader  ──→  ~/.codex/state_*.sqlite  (threads)
                │                    ──→  ~/.codex/models_cache.json (models)
                ├── CodexAuth        ──→  codex login/logout subprocess
                ├── Attachments      ──→  .telecodex/inbox/<turnId>/ (staged files)
                ├── Artifacts        ──→  .telecodex/outbox/<turnId>/ (generated files)
                └── VoiceTranscriber  ──→  Qwen3-ASR resident server (Chinese)
                                     ──→  parakeet-coreml (local fallback)
                                     ──→  OpenAI transcription (cloud fallback)
```

## Project Layout

```
TeleCodex/
├── src/
│   ├── index.ts           — startup, signal handling, polling loop
│   ├── bot.ts             — Telegram bot, all commands and handlers
│   ├── bot-ui.ts          — pure render helpers (/help, /start, session labels)
│   ├── codex-launch.ts    — launch profile parsing, validation, and formatting
│   ├── codex-session.ts   — CodexSessionService wrapping the SDK
│   ├── codex-state.ts     — SQLite reader for thread/model discovery
│   ├── codex-auth.ts      — Codex CLI auth (login status, device auth, logout)
│   ├── session-registry.ts — per-context session map with persistence
│   ├── context-key.ts     — Telegram chat/topic → context key derivation
│   ├── attachments.ts     — file staging (sanitization, size limits)
│   ├── artifacts.ts       — generated file collection and Telegram delivery
│   ├── error-messages.ts  — SDK/network error → user-friendly translation
│   ├── voice.ts           — voice transcription (Qwen / parakeet / OpenAI)
│   ├── telegram-transport.ts — direct cross-persona Telegram transport
│   ├── telegram-transport-mcp-server.ts — stdio MCP wrapper for Codex CLI
│   ├── config.ts          — environment loading and validation
│   └── format.ts          — Markdown → Telegram HTML conversion
├── test/                  — 15 test files, 180+ tests (vitest)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
└── vitest.config.ts
```

## Docker

```bash
docker compose up --build
```

The compose file:
- loads environment from `.env`
- mounts `~/.codex` for auth state and persisted threads
- mounts `./workspace` as `/workspace`
- runs as a non-root user

## Development

```bash
npm run dev      # run with tsx (no build step)
npm run build    # compile TypeScript
npm test         # run vitest
```

## Release Automation

TeleCodex does not yet use the TelePi npm release pipeline, but the exact Trusted Publishing process has been documented so it can be adopted here.

See:
- `docs/npm-trusted-publishing.md`

That playbook covers:
- making the package publishable on npm
- adding a tag-driven GitHub Actions workflow
- configuring npm Trusted Publishing
- the maintainer release flow (`npm version ...` + `git push --follow-tags`)

## Security Notes

- Only users in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot
- Default sandbox mode is `workspace-write` — Codex can read and write within the working directory
- Use `danger-full-access` only if you fully trust the user and the host environment
- The built-in `Full Access` profile and any extra `danger-full-access` launch profiles are opt-in via `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Default approval policy is `never` — suited for headless/automated use
- `/launch_profiles` only selects from validated configured profiles; Telegram users cannot submit arbitrary sandbox or approval values
- `CODEX_API_KEY` (agent auth) and `OPENAI_API_KEY` (OpenAI voice fallback) are separate credentials
- `/login` and `/logout` can be disabled by setting `ENABLE_TELEGRAM_LOGIN=false`
- Files uploaded via Telegram are sanitized (name, size, type) before staging in the workspace
- All Markdown output is sanitized before being sent as Telegram HTML
