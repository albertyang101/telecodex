import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";

const mockGrammy = vi.hoisted(() => {
  const bots: any[] = [];

  class FakeInlineKeyboard {
    text(): FakeInlineKeyboard {
      return this;
    }

    row(): FakeInlineKeyboard {
      return this;
    }
  }

  class FakeInputFile {
    constructor(
      public readonly path: string,
      public readonly filename?: string,
    ) {}
  }

  const Bot = vi.fn().mockImplementation((token: string) => {
    const handlers = {
      use: [] as any[],
      commands: new Map<string, any>(),
      callbacks: [] as any[],
      on: new Map<string, any>(),
      hears: [] as any[],
      catch: undefined as any,
    };
    const api = {
      config: { use: vi.fn() },
      sendChatAction: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockImplementation(async () => ({ message_id: api.sendMessage.mock.calls.length })),
      editMessageText: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      setMyCommands: vi.fn().mockResolvedValue(true),
      setMessageReaction: vi.fn().mockResolvedValue(true),
    };
    const bot = {
      token,
      api,
      use: vi.fn((handler: any) => {
        handlers.use.push(handler);
      }),
      command: vi.fn((command: string, handler: any) => {
        handlers.commands.set(command, handler);
      }),
      callbackQuery: vi.fn((pattern: any, handler: any) => {
        handlers.callbacks.push({ pattern, handler });
      }),
      hears: vi.fn((pattern: any, handler: any) => {
        handlers.hears.push({ pattern, handler });
      }),
      on: vi.fn((filter: any, handler: any) => {
        const key = Array.isArray(filter) ? filter.join("|") : filter;
        handlers.on.set(key, handler);
      }),
      catch: vi.fn((handler: any) => {
        handlers.catch = handler;
      }),
      __handlers: handlers,
    };
    bots.push(bot);
    return bot;
  });

  return { Bot, FakeInlineKeyboard, FakeInputFile, bots };
});

const mockAuth = vi.hoisted(() => ({
  checkAuthStatus: vi.fn().mockResolvedValue({
    authenticated: true,
    method: "cli",
    detail: "authenticated",
  }),
  clearAuthCache: vi.fn(),
  startLogin: vi.fn(),
  startLogout: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: mockGrammy.Bot,
  InlineKeyboard: mockGrammy.FakeInlineKeyboard,
  InputFile: mockGrammy.FakeInputFile,
}));

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(() => "auto-retry-middleware"),
}));

vi.mock("../src/codex-auth.js", () => mockAuth);

import { createBot, registerCommands } from "../src/bot.js";
import { HANDOFF_MARKER } from "../src/handoff-buffer.js";
import { _resetImportHook, _setDecodeHook, _setImportHook } from "../src/voice.js";

describe("createBot response delivery", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalVoiceBackend = process.env.VOICE_TRANSCRIPTION_BACKEND;
  const originalQwenSocket = process.env.QWEN_ASR_SOCKET;
  const originalTelegramFileDownloadTimeoutMs = process.env.TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS;
  const originalVoiceTranscriptionTimeoutMs = process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS;
  const tempDirs: string[] = [];
  let defaultWorkspace = path.join(tmpdir(), "telecodex-bot-test-workspace-initial");

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: defaultWorkspace,
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "gpt-5.5",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "none",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    streamAgentResponses: false,
    memoryTranscriptRoot: undefined,
    mailboxBridge: {
      enabled: false,
      persona: undefined,
      personasRoot: "/Users/albert/personas",
      contextKey: undefined,
      pollMs: 500,
      fullScanMs: 10_000,
      autoReply: false,
      maxMessagesPerTick: 1,
    },
    autoRotate: { enabled: false, threshold: 0.45, contextWindow: 258400 },
    ...overrides,
  });

  const createSession = (
    onPrompt: (callbacks: CodexSessionCallbacks, input: unknown) => Promise<void>,
  ) => ({
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    newThread: vi.fn(),
    switchSession: vi.fn(async () => ({
      threadId: "thread-switched",
      workspace: "/workspace/base",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })),
    listWorkspaces: vi.fn(() => []),
    listAllSessions: vi.fn(() => []),
    getCurrentWorkspace: vi.fn(() => defaultWorkspace),
    prompt: vi.fn(async (input, callbacks: CodexSessionCallbacks) => {
      await onPrompt(callbacks, input);
    }),
    abort: vi.fn(async () => undefined),
    getInfo: vi.fn(() => ({
      threadId: "thread-1",
      workspace: defaultWorkspace,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })),
  });

  const createRegistry = (session: any) => {
    const removeCallbacks: Array<(key: string) => void> = [];
    return {
      __removeCallbacks: removeCallbacks,
      onRemove: vi.fn((callback: (key: string) => void) => {
        removeCallbacks.push(callback);
      }),
      get: vi.fn(() => session),
      getOrCreate: vi.fn(async () => session),
      updateMetadata: vi.fn(),
    };
  };

  const createWorkspace = async (prefix: string): Promise<string> => {
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(workspace);
    return workspace;
  };

  beforeEach(() => {
    defaultWorkspace = path.join(
      tmpdir(),
      `telecodex-bot-test-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempDirs.push(defaultWorkspace);
    mockGrammy.bots.length = 0;
    mockGrammy.Bot.mockClear();
    mockAuth.checkAuthStatus.mockReset();
    mockAuth.checkAuthStatus.mockResolvedValue({
      authenticated: true,
      method: "cli",
      detail: "authenticated",
    });
    mockAuth.startLogin.mockReset();
    mockAuth.startLogout.mockReset();
    process.env.VOICE_TRANSCRIPTION_BACKEND = "parakeet";
    process.env.QWEN_ASR_SOCKET = "/tmp/telecodex-test-missing-qwen-asr.sock";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    _resetImportHook();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    if (originalVoiceBackend === undefined) {
      delete process.env.VOICE_TRANSCRIPTION_BACKEND;
    } else {
      process.env.VOICE_TRANSCRIPTION_BACKEND = originalVoiceBackend;
    }
    if (originalQwenSocket === undefined) {
      delete process.env.QWEN_ASR_SOCKET;
    } else {
      process.env.QWEN_ASR_SOCKET = originalQwenSocket;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalTelegramFileDownloadTimeoutMs === undefined) {
      delete process.env.TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS;
    } else {
      process.env.TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = originalTelegramFileDownloadTimeoutMs;
    }
    if (originalVoiceTranscriptionTimeoutMs === undefined) {
      delete process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS;
    } else {
      process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS = originalVoiceTranscriptionTimeoutMs;
    }
  });

  it("auto-rotates to a fresh thread and injects a HANDOFF after a context-heavy turn (ALB-1011)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("收到，我看一下");
      callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 10 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-heavy-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({ chat: { id: 4242 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：部署脚本超时没兜住" }, api: bot.api });
    expect(session.newThread).not.toHaveBeenCalled();

    await textHandler({ chat: { id: 4242 }, from: { id: 123 }, message: { message_id: 2, text: "第二条：继续修" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(1);
    const secondInput = JSON.stringify(session.prompt.mock.calls[1][0]);
    expect(secondInput).toContain(HANDOFF_MARKER);
    expect(secondInput).toContain("第一条：部署脚本超时没兜住");
    expect(secondInput).toContain("第二条：继续修");
  });

  it("does not rotate while turns stay light (ALB-1011)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens: 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-light-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({ chat: { id: 7373 }, from: { id: 123 }, message: { message_id: 1, text: "light-1" }, api: bot.api });
    await textHandler({ chat: { id: 7373 }, from: { id: 123 }, message: { message_id: 2, text: "light-2" }, api: bot.api });
    await textHandler({ chat: { id: 7373 }, from: { id: 123 }, message: { message_id: 3, text: "light-3" }, api: bot.api });
    expect(session.newThread).not.toHaveBeenCalled();
  });

  it("never rotates when auto-rotate is disabled, even after a heavy turn (ALB-1011)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens: 200000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-disabled-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: false, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({ chat: { id: 8484 }, from: { id: 123 }, message: { message_id: 1, text: "heavy-1" }, api: bot.api });
    await textHandler({ chat: { id: 8484 }, from: { id: 123 }, message: { message_id: 2, text: "heavy-2" }, api: bot.api });
    expect(session.newThread).not.toHaveBeenCalled();
  });

  it("keeps the pending rotation alive when newThread() fails, so a later turn still rotates (ALB-1011)", async () => {
    let inputTokens = 130000;
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    session.newThread.mockRejectedValueOnce(new Error("transient newThread failure")).mockResolvedValue(session.getInfo());
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-retry-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({ chat: { id: 5151 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：重活把上下文顶上去" }, api: bot.api });
    expect(session.newThread).not.toHaveBeenCalled();

    inputTokens = 40000;
    await textHandler({ chat: { id: 5151 }, from: { id: 123 }, message: { message_id: 2, text: "第二条：轻活" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(1);
    const turn2Input = JSON.stringify(session.prompt.mock.calls[1][0]);
    expect(turn2Input).not.toContain(HANDOFF_MARKER);

    await textHandler({ chat: { id: 5151 }, from: { id: 123 }, message: { message_id: 3, text: "第三条：还是轻活" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(2);
    const turn3Input = JSON.stringify(session.prompt.mock.calls[2][0]);
    expect(turn3Input).toContain(HANDOFF_MARKER);
    expect(turn3Input).toContain("第一条：重活把上下文顶上去");
  });

  it("keeps a pending rotation when the rotated prompt fails after newThread succeeds (ALB-1011)", async () => {
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onAgentMessage?.("heavy ok");
        callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
        callbacks.onAgentEnd();
        return;
      }
      if (promptCount === 2) {
        throw new Error("post-rotation prompt failure");
      }
      callbacks.onAgentMessage?.("recovered");
      callbacks.onTurnComplete?.({ inputTokens: 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-prompt-fail-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({ chat: { id: 6161 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：重活" }, api: bot.api });
    await textHandler({ chat: { id: 6161 }, from: { id: 123 }, message: { message_id: 2, text: "第二条：旋转后失败" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(1);

    await textHandler({ chat: { id: 6161 }, from: { id: 123 }, message: { message_id: 3, text: "第三条：应该重试 handoff" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(2);
    const turn3Input = JSON.stringify(session.prompt.mock.calls[2][0]);
    expect(turn3Input).toContain(HANDOFF_MARKER);
    expect(turn3Input).toContain("第一条：重活");
  });

  it("clears pending rotation when the user manually switches sessions (ALB-1011)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-switch-clear-");
    const bot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const switchHandler = [...bot.__handlers.commands.entries()].find(([key]: [unknown, unknown]) => Array.isArray(key) && key.includes("switch"))?.[1];
    expect(switchHandler).toBeTypeOf("function");

    await textHandler({ chat: { id: 6262 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：触发 pending" }, api: bot.api });
    await switchHandler({ chat: { id: 6262 }, from: { id: 123 }, message: { message_id: 2, text: "/switch thread-other" }, api: bot.api });
    await textHandler({ chat: { id: 6262 }, from: { id: 123 }, message: { message_id: 3, text: "切换后继续" }, api: bot.api });

    expect(session.switchSession).toHaveBeenCalledWith("thread-other");
    expect(session.newThread).not.toHaveBeenCalled();
    const turn2Input = JSON.stringify(session.prompt.mock.calls[1][0]);
    expect(turn2Input).not.toContain(HANDOFF_MARKER);
  });

  it("strips echoed rotation handoff blocks from visible Telegram replies (ALB-1011)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta(HANDOFF_MARKER + "\n[用户] 旧内容\n--- 交接结束，请接着回应用户接下来的消息 ---\n\n真正回复");
      callbacks.onAgentMessage?.(HANDOFF_MARKER + "\n[用户] 旧内容\n--- 交接结束，请接着回应用户接下来的消息 ---\n\n真正回复");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({ chat: { id: 6363 }, from: { id: 123 }, message: { message_id: 1, text: "hi" }, api: bot.api });

    const visible = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visible).toContain("真正回复");
    expect(visible).not.toContain(HANDOFF_MARKER);
    expect(visible).not.toContain("旧内容");
  });

  it("loads a persisted pending rotation after restart and consumes it on the next turn (ALB-1011)", async () => {
    const workspace = await createWorkspace("telecodex-rotation-restart-");
    const firstSession = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("heavy ok");
      callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const firstBot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), createRegistry(firstSession) as any) as any;
    const firstTextHandler = firstBot.__handlers.on.get("message:text");
    await firstTextHandler({ chat: { id: 6464 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：重启前重活" }, api: firstBot.api });

    const secondSession = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("after restart");
      callbacks.onTurnComplete?.({ inputTokens: 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const secondBot = createBot(createConfig({ workspace, autoRotate: { enabled: true, threshold: 0.45, contextWindow: 258400 } } as any), createRegistry(secondSession) as any) as any;
    const secondTextHandler = secondBot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await secondTextHandler({ chat: { id: 6464 }, from: { id: 123 }, message: { message_id: 2, text: "重启后继续" }, api: secondBot.api });

    expect(secondSession.newThread).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(secondSession.prompt.mock.calls[0][0]);
    expect(input).toContain(HANDOFF_MARKER);
    expect(input).toContain("第一条：重启前重活");
  });

  it("retries newThread once on a mandatory (hard-cap) rotation and refuses the turn when both attempts fail (ALB-1205)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens: 200000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    session.newThread
      .mockRejectedValueOnce(new Error("newThread failure #1"))
      .mockRejectedValueOnce(new Error("newThread failure #2"))
      .mockResolvedValue(session.getInfo());
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-hardcap-");
    const bot = createBot(
      createConfig({
        workspace,
        autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 },
      } as any),
      registry as any,
    ) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Turn 1 crosses the hard cap (200000/258400 ≈ 0.77 ≥ 0.60) → mandatory pending.
    await textHandler({ chat: { id: 9191 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：把上下文顶过硬上限" }, api: bot.api });
    expect(session.newThread).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);

    // Turn 2: mandatory rotation → newThread tried twice, both fail → the turn is
    // refused (no prompt on the over-cap thread) and the user is told.
    await textHandler({ chat: { id: 9191 }, from: { id: 123 }, message: { message_id: 2, text: "第二条：这条不该在超限线程上跑" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    const sent = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(sent).toContain("硬上限");

    // Turn 3: newThread recovers → the preserved mandatory pending finally rotates
    // with a hard-cap HANDOFF carrying the earlier exchange.
    await textHandler({ chat: { id: 9191 }, from: { id: 123 }, message: { message_id: 3, text: "第三条：现在应该翻页了" }, api: bot.api });
    expect(session.newThread).toHaveBeenCalledTimes(3);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const rotatedInput = JSON.stringify(session.prompt.mock.calls[1][0]);
    expect(rotatedInput).toContain(HANDOFF_MARKER);
    expect(rotatedInput).toContain("硬上限");
    expect(rotatedInput).toContain("第一条：把上下文顶过硬上限");
  });

  it("snapshots queued unanswered messages into the rotation HANDOFF (ALB-1205)", async () => {
    let releaseTurn1!: () => void;
    const turn1Gate = new Promise<void>((resolve) => {
      releaseTurn1 = resolve;
    });
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        await turn1Gate;
        callbacks.onAgentMessage?.("第一条答完");
        callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
        callbacks.onAgentEnd();
        return;
      }
      callbacks.onAgentMessage?.("ok");
      callbacks.onTurnComplete?.({ inputTokens: 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const workspace = await createWorkspace("telecodex-rotation-unanswered-");
    const bot = createBot(
      createConfig({
        workspace,
        autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 },
      } as any),
      registry as any,
    ) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Turn 1 hangs; messages 2 and 3 arrive meanwhile and are queued.
    const turn1 = textHandler({ chat: { id: 9292 }, from: { id: 123 }, message: { message_id: 1, text: "第一条：慢活" }, api: bot.api });
    await textHandler({ chat: { id: 9292 }, from: { id: 123 }, message: { message_id: 2, text: "第二条：排队中" }, api: bot.api });
    await textHandler({ chat: { id: 9292 }, from: { id: 123 }, message: { message_id: 3, text: "第三条：也在排队" }, api: bot.api });

    // Turn 1 completes heavy → pending rotation. Draining then runs message 2,
    // which rotates; message 3 is still queued at that instant and must appear
    // in the HANDOFF's unanswered section.
    releaseTurn1();
    await turn1;

    expect(session.newThread).toHaveBeenCalledTimes(1);
    const rotatedInput = JSON.stringify(session.prompt.mock.calls[1][0]);
    expect(rotatedInput).toContain(HANDOFF_MARKER);
    expect(rotatedInput).toContain("未答消息");
    expect(rotatedInput).toContain("第三条：也在排队");
    // ALB-1205: the message currently being handled (第二条) is delivered as this
    // very turn's live prompt — it must NOT also be listed as unanswered backlog in
    // the HANDOFF. On the drain path it is still queue[0] when rotation snapshots, so
    // without excluding it the new thread is told to "答完" a message it is answering
    // right now. It must appear exactly once (the live prompt), never twice.
    const currentMsgOccurrences = (rotatedInput.match(/第二条：排队中/g) ?? []).length;
    expect(currentMsgOccurrences).toBe(1);
  });

  // ALB-1205 SENTINEL: the canonical "interrupted turn (最后断点) on a Telegram
  // turn-timeout abort" test was dropped when replaying onto the live baseline.
  // The live Telegram path is no-turn-timeout (2026-06-29 live decision) — there is
  // no codexTurnTimeoutMs / CodexTurnTimeoutError on this path, so the abort that
  // this test simulated cannot occur. The interrupted-turn feature lives on the
  // mailbox path (worker bots run there and keep their own promptTimeoutMs); its
  // coverage is in test/mailbox.test.ts.

  it("shows the active voice backend separately from available backends", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 1 };
        }
      },
    }));
    const session = createSession(async (callbacks) => {
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const voiceCommand = bot.__handlers.commands.get("voice");

    await voiceCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 9, text: "/voice" },
      api: bot.api,
    });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const html = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(html).toContain("Active backend:");
    expect(html).toContain("<code>openai</code>");
    expect(html).toContain("Available:");
    expect(html).toContain("parakeet + openai");
  });

  it("shows voice backend configuration errors in /voice", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwne";
    const session = createSession(async (callbacks) => {
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const voiceCommand = bot.__handlers.commands.get("voice");

    await voiceCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 9, text: "/voice" },
      api: bot.api,
    });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const html = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(html).toContain("Voice transcription configuration error");
    expect(html).toContain("VOICE_TRANSCRIPTION_BACKEND");
  });

  it("waits for an active text turn before reporting idle during shutdown", async () => {
    const releasePrompt = deferred<void>();
    const session = createSession(async (callbacks) => {
      await releasePrompt.promise;
      callbacks.onAgentMessage?.("drained reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const turn = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 7, text: "hold this turn" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    let idleResolved = false;
    const idle = bot.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();

    expect(bot.getInFlightCount()).toBe(1);
    expect(idleResolved).toBe(false);

    releasePrompt.resolve();
    await turn;
    await idle;

    expect(bot.getInFlightCount()).toBe(0);
    expect(idleResolved).toBe(true);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain("drained reply");
  });

  it("tracks authorized text updates while middleware is still dispatching during shutdown", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const middleware = bot.__handlers.use[0];
    const releaseNext = deferred<void>();
    let nextStarted = false;

    const turn = middleware(
      {
        update: { update_id: 77 },
        chat: { id: 42, type: "private" },
        from: { id: 123 },
        message: { message_id: 8, text: "hold before text handler" },
        api: bot.api,
      },
      async () => {
        nextStarted = true;
        await releaseNext.promise;
      },
    );

    await vi.waitFor(() => expect(nextStarted).toBe(true));

    let idleResolved = false;
    const idle = bot.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();

    expect(bot.getInFlightCount()).toBe(1);
    expect(idleResolved).toBe(false);

    releaseNext.resolve();
    await turn;
    await idle;

    expect(bot.getInFlightCount()).toBe(0);
    expect(idleResolved).toBe(true);
  });

  it("can buffer agent deltas and only send the final response to Telegram", async () => {
    let sendsBeforeAgentEnd = -1;
    let botInstance: any;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("中间草稿，不应该提前发出。");
      await Promise.resolve();
      sendsBeforeAgentEnd = botInstance.api.sendMessage.mock.calls.length;

      callbacks.onTextDelta("\n真正回复。");
      callbacks.onAgentMessage?.("真正回复。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    botInstance = mockGrammy.bots[0];
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 7, text: "帮我查一下" },
      api: bot.api,
    });

    expect(sendsBeforeAgentEnd).toBe(0);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls[0][1]).not.toContain("中间草稿");
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain("真正回复。");
  });

  it("does not fall back to buffered draft text when final agent message is empty", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("中间草稿，不应该作为最终回复。");
      callbacks.onAgentMessage?.("");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 69, text: "帮我处理一下" },
      api: bot.api,
    });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain("✅ Done");
    expect(bot.api.sendMessage.mock.calls[0][1]).not.toContain("中间草稿");
  });

  it("appends Graphiti source session turns when a memory transcript root is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-memory-"));
    tempDirs.push(root);
    const sessionsRoot = path.join(root, "Sessions");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("ALB-833 测试回复");
      callbacks.onAgentMessage?.("ALB-833 测试回复");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ memoryTranscriptRoot: sessionsRoot }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 91, text: "请记录 ALB-833 测试输入" },
      api: bot.api,
    });

    const files = await readdir(sessionsRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^20\d{2}-\d{2}-\d{2}\.md$/);
    const transcript = await readFile(path.join(sessionsRoot, files[0]!), "utf8");

    expect(transcript).toContain("[user-raw]");
    expect(transcript).toMatch(/^## \d{2}:\d{2}:\d{2} \[user-raw\]/m);
    expect(transcript).toContain("<!-- message_id=42:91; context_key=42; thread_id=thread-1 -->");
    expect(transcript).toContain("请记录 ALB-833 测试输入");
    expect(transcript).toContain("[bot-raw]");
    expect(transcript).toMatch(/^## \d{2}:\d{2}:\d{2} \[bot-raw\]/m);
    expect(transcript).toContain("<!-- message_id=42:91; context_key=42; thread_id=thread-1 -->");
    expect(transcript).toContain("ALB-833 测试回复");
    expect(transcript).not.toContain("Albert: 请记录 ALB-833 测试输入");
    expect(transcript).not.toContain("Assistant: ALB-833 测试回复");
    expect(transcript).not.toContain("session_id=");
  });

  it("records the visible fallback bot turn when the final agent message is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-memory-empty-"));
    tempDirs.push(root);
    const sessionsRoot = path.join(root, "Sessions");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("中间草稿，不进最终记忆。");
      callbacks.onAgentMessage?.("");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ memoryTranscriptRoot: sessionsRoot }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 92, text: "空回复 fallback 测试" },
      api: bot.api,
    });

    const files = await readdir(sessionsRoot);
    const transcript = await readFile(path.join(sessionsRoot, files[0]!), "utf8");

    expect(transcript).toContain("[user-raw]");
    expect(transcript).toContain("空回复 fallback 测试");
    expect(transcript).toContain("[bot-raw]");
    expect(transcript).toContain("Done");
    expect(transcript).not.toContain("中间草稿，不进最终记忆。");
  });

  it("records completed streaming progress before a later prompt failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-memory-stream-failure-"));
    tempDirs.push(root);
    const sessionsRoot = path.join(root, "Sessions");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("已完成的阶段进度。");
      callbacks.onAgentMessage?.("已完成的阶段进度。");
      throw new Error("provider failed");
    });
    const registry = createRegistry(session);

    const bot = createBot(
      createConfig({ memoryTranscriptRoot: sessionsRoot, streamAgentResponses: true }),
      registry as any,
    ) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 98, text: "阶段后失败" },
      api: bot.api,
    });

    const files = await readdir(sessionsRoot);
    const transcript = await readFile(path.join(sessionsRoot, files[0]!), "utf8");
    const visibleReplyTexts = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1]));
    const visibleReplies = visibleReplyTexts.join("\n");

    expect(visibleReplyTexts.filter((text: string) => text.includes("已完成的阶段进度。"))).toHaveLength(1);
    expect(visibleReplies).toContain("已完成的阶段进度。");
    expect(visibleReplies).toContain("provider failed");
    expect(transcript).toContain("[bot-raw]");
    expect(transcript).toContain("已完成的阶段进度。");
    expect(transcript).toContain("provider failed");
  });

  it("records prompt failure replies as bot turns without leaking raw provider URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-memory-prompt-failure-"));
    tempDirs.push(root);
    const sessionsRoot = path.join(root, "Sessions");
    const session = createSession(async () => {
      throw new Error(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 28th, 2026 6:15 PM.",
      );
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ memoryTranscriptRoot: sessionsRoot }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 97, text: "触发 usage cap" },
      api: bot.api,
    });

    const files = await readdir(sessionsRoot);
    const transcript = await readFile(path.join(sessionsRoot, files[0]!), "utf8");
    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");

    expect(visibleReplies).toContain("Codex usage limit");
    expect(visibleReplies).not.toContain("https://chatgpt.com");
    expect(transcript).toContain("[user-raw]");
    expect(transcript).toContain("触发 usage cap");
    expect(transcript).toContain("[bot-raw]");
    expect(transcript).toContain("Codex usage limit");
    expect(transcript).not.toContain("https://chatgpt.com");
  });

  it("keeps replying and avoids logging turn text when memory append fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-memory-fail-"));
    tempDirs.push(root);
    const blockedRoot = path.join(root, "not-a-directory");
    await writeFile(blockedRoot, "blocks mkdir");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("ALB-833 visible reply after append failure");
      callbacks.onAgentMessage?.("ALB-833 visible reply after append failure");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    try {
      const bot = createBot(createConfig({ memoryTranscriptRoot: blockedRoot }), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 93, text: "ALB-833 append failure input" },
        api: bot.api,
      });

      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
      expect(bot.api.sendMessage.mock.calls[0][1]).toContain("ALB-833 visible reply after append failure");
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("Failed to append memory user turn");
      expect(logged).toContain("Failed to append memory bot turn");
      expect(logged).not.toContain("ALB-833 append failure input");
      expect(logged).not.toContain("ALB-833 visible reply after append failure");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("prepends Telegram reply style guard before sending user text to Codex", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("短答。");
      callbacks.onAgentMessage?.("短答。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 70, text: "帮我看下巴黎天气" },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const codexInput = session.prompt.mock.calls[0][0] as string;
    expect(codexInput).toContain("[TELEGRAM REPLY STYLE]");
    expect(codexInput).toContain("默认不要贴来源、参考资料、citation、URL 或链接清单");
    expect(codexInput).toContain("帮我看下巴黎天气");
  });

  it("prepends developer discipline before sending user text to Codex", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.("收到。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 73, text: "修一下这个 bug" },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const codexInput = session.prompt.mock.calls[0][0] as string;
    expect(codexInput).toContain("[DEVELOPER DISCIPLINE]");
    expect(codexInput).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(codexInput).toContain("find the first cause");
    expect(codexInput).toContain("check existing architecture/tooling before adding new code");
    expect(codexInput).toContain("fix at the earliest reliable boundary");
    expect(codexInput).toContain("workarounds are temporary and require Linear follow-up");
    expect(codexInput).toContain("修一下这个 bug");
  });

  it("does not expose echoed developer discipline in final Telegram replies", async () => {
    const echoed = [
      "[DEVELOPER DISCIPLINE]",
      "discipline_version=ALB-714-hard-discipline-v1",
      "Use Superpowers discipline: research first, systematic debugging, TDD red/green for behavior changes, review, and verification before completion.",
      "Do not touch Memory/Graphiti/personal memory unless Albert explicitly authorizes it.",
      "",
      "实际回复。",
    ].join("\n");
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.(echoed);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 74, text: "只要结论" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("实际回复。");
    expect(sent).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(sent).not.toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(sent).not.toContain("Superpowers discipline");
    expect(sent).not.toContain("Memory/Graphiti");
  });

  it("does not expose markdown-decorated developer discipline echoes", async () => {
    const echoed = [
      "> [DEVELOPER DISCIPLINE]",
      "> discipline_version=ALB-714-hard-discipline-v1",
      "- Fix root cause: explain why a bug happened before fixing it, then fix at the earliest reliable boundary.",
      "* Do not stack downstream symptom patches; workarounds are temporary and require Linear follow-up.",
      "",
      "正常回复。",
    ].join("\n");
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.(echoed);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 82, text: "不要泄露规则" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("正常回复。");
    expect(sent).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(sent).not.toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(sent).not.toContain("Fix root cause");
    expect(sent).not.toContain("downstream symptom patches");
  });

  it("does not expose inline-code or bold developer discipline echoes", async () => {
    const echoed = [
      "`[DEVELOPER DISCIPLINE]`",
      "`discipline_version=ALB-714-hard-discipline-v1`",
      "- **Fix root cause:** explain why a bug happened before fixing it, then fix at the earliest reliable boundary.",
      "- **Do not stack downstream symptom patches; workarounds are temporary and require Linear follow-up.**",
      "",
      "干净回复。",
    ].join("\n");
    const session = createSession(async (callbacks) => {
      callbacks.onAgentMessage?.(echoed);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 83, text: "只要干净回复" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("干净回复。");
    expect(sent).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(sent).not.toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(sent).not.toContain("Fix root cause");
    expect(sent).not.toContain("downstream symptom patches");
  });

  it("adds runtime identity facts before sending normal user text to Codex", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("我知道当前运行配置。");
      callbacks.onAgentMessage?.("我知道当前运行配置。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 72, text: "你是谁，用的什么模型和 effort？" },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const codexInput = String(session.prompt.mock.calls[0][0]);
    expect(codexInput).toContain("[CURRENT CONTEXT]");
    expect(codexInput).toContain("You are Albert Codex Dispatcher backend for Telegram.");
    expect(codexInput).toContain("Current model: gpt-5.5");
    expect(codexInput).toContain("Current reasoning effort: xhigh");
    expect(codexInput).not.toMatch(/runtime facts/i);
    expect(codexInput).toContain("你是谁，用的什么模型和 effort？");
  });

  it("removes trailing source footers when the user did not ask for sources", async () => {
    const session = createSession(async (callbacks) => {
      const reply = [
        "巴黎下周会比墨尔本热很多，按夏天准备。",
        "",
        "来源：",
        "Le Monde: https://example.com/heatwave",
        "Weather: https://example.com/weather",
      ].join("\n");
      callbacks.onTextDelta(reply);
      callbacks.onAgentMessage?.(reply);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 71, text: "巴黎和墨尔本夏天天气差多少" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("巴黎下周会比墨尔本热很多");
    expect(sent).not.toContain("来源");
    expect(sent).not.toContain("https://");
  });

  it.each([
    "这个错误来源是什么？",
    "链接失败怎么修？",
    "官网挂了怎么办？",
    "我需要知道这个错误来源是什么？",
    "需要排查链接失败原因",
    "需要官网恢复方案",
  ])(
    "does not treat source/link wording as a citation request: %s",
    async (requestText) => {
      const session = createSession(async (callbacks) => {
        const reply = ["问题在配置。", "", "来源：", "https://example.com/internal"].join("\n");
        callbacks.onTextDelta(reply);
        callbacks.onAgentMessage?.(reply);
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig(), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 78, text: requestText },
        api: bot.api,
      });

      const sent = bot.api.sendMessage.mock.calls[0][1] as string;
      expect(sent).toContain("问题在配置。");
      expect(sent).not.toContain("来源");
      expect(sent).not.toContain("https://");
    },
  );

  it("removes trailing source footers without URLs", async () => {
    const session = createSession(async (callbacks) => {
      const reply = ["结论是配置问题。", "", "来源：OpenAI docs"].join("\n");
      callbacks.onTextDelta(reply);
      callbacks.onAgentMessage?.(reply);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 79, text: "这个问题怎么回事" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("结论是配置问题。");
    expect(sent).not.toContain("来源");
    expect(sent).not.toContain("OpenAI docs");
  });

  it("does not expose partial source headings in completed streaming messages", async () => {
    let sendsBeforeAgentEnd = -1;
    let botInstance: any;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta(["结论是配置问题。", "", "来源："].join("\n"));
      await Promise.resolve();
      sendsBeforeAgentEnd = botInstance.api.sendMessage.mock.calls.length;
      callbacks.onAgentMessage?.(["结论是配置问题。", "", "来源：OpenAI docs"].join("\n"));
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    botInstance = mockGrammy.bots[0];
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 80, text: "这个问题怎么回事" },
      api: bot.api,
    });

    expect(sendsBeforeAgentEnd).toBe(0);
    const firstVisible = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(firstVisible).toContain("结论是配置问题。");
    expect(firstVisible).not.toContain("来源");
  });

  it("does not expose source footers in completed streaming messages", async () => {
    let sendsBeforeAgentEnd = -1;
    let botInstance: any;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta(
        [
          "巴黎下周会比墨尔本热很多，按夏天准备。",
          "",
          "来源：",
          "https://example.com/weather",
        ].join("\n"),
      );
      await Promise.resolve();
      sendsBeforeAgentEnd = botInstance.api.sendMessage.mock.calls.length;
      callbacks.onAgentMessage?.(
        [
          "巴黎下周会比墨尔本热很多，按夏天准备。",
          "",
          "来源：",
          "https://example.com/weather",
        ].join("\n"),
      );
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    botInstance = mockGrammy.bots[0];
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 73, text: "巴黎和墨尔本夏天天气差多少" },
      api: bot.api,
    });

    expect(sendsBeforeAgentEnd).toBe(0);
    const firstVisible = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(firstVisible).toContain("巴黎下周会比墨尔本热很多");
    expect(firstVisible).not.toContain("来源");
    expect(firstVisible).not.toContain("https://");
  });

  it("strips source and discipline-only completed messages without blocking later bubbles", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("第一段安全结论。");
      callbacks.onAgentMessage?.("第一段安全结论。");
      callbacks.onTextDelta(["来源：", "https://example.com/internal"].join("\n"));
      callbacks.onAgentMessage?.(["来源：", "https://example.com/internal"].join("\n"));
      callbacks.onTextDelta(["[DEVELOPER DISCIPLINE]", "discipline_version=ALB-714-hard-discipline-v1"].join("\n"));
      callbacks.onAgentMessage?.(["[DEVELOPER DISCIPLINE]", "discipline_version=ALB-714-hard-discipline-v1"].join("\n"));
      callbacks.onTextDelta("最后一段安全结论。");
      callbacks.onAgentMessage?.("最后一段安全结论。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 75, text: "这个问题怎么回事" },
      api: bot.api,
    });

    const visible = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visible).toContain("第一段安全结论。");
    expect(visible).toContain("最后一段安全结论。");
    expect(visible).not.toContain("https://");
    expect(visible).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(visible).not.toContain("discipline_version=");
  });

  it("keeps substantive source wording that is not a citation footer", async () => {
    const session = createSession(async (callbacks) => {
      const reply = "结论：不是 API 问题。\n\n来源不是 API，而是配置。";
      callbacks.onTextDelta(reply);
      callbacks.onAgentMessage?.(reply);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 74, text: "这个问题怎么回事" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("来源不是 API，而是配置");
  });

  it("keeps source footers when the user explicitly asks for sources", async () => {
    const session = createSession(async (callbacks) => {
      const reply = [
        "巴黎下周会比墨尔本热很多。",
        "",
        "来源：",
        "https://example.com/weather",
      ].join("\n");
      callbacks.onTextDelta(reply);
      callbacks.onAgentMessage?.(reply);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 72, text: "巴黎和墨尔本夏天天气差多少，带来源" },
      api: bot.api,
    });

    const sent = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(sent).toContain("来源");
    expect(sent).toContain("https://example.com/weather");
  });

  it.each([
    "官网网址发我",
    "不要省略来源",
    "别忘了给链接",
    "需要来源",
    "需要链接",
    "我需要来源",
    "需要参考资料",
    "show me the links",
    "provide the sources",
    "include the URLs",
  ])(
    "keeps source footers for explicit source/link request: %s",
    async (requestText) => {
      const session = createSession(async (callbacks) => {
        const reply = ["官网在这里。", "", "来源：", "https://example.com/official"].join("\n");
        callbacks.onTextDelta(reply);
        callbacks.onAgentMessage?.(reply);
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig(), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 75, text: requestText },
        api: bot.api,
      });

      const sent = bot.api.sendMessage.mock.calls[0][1] as string;
      expect(sent).toContain("来源");
      expect(sent).toContain("https://example.com/official");
    },
  );

  it("does not expose voice transcripts before sending them to Codex", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("我听到了。");
      callbacks.onAgentMessage?.("我听到了。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/private.ogg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    _setDecodeHook(async () => new Float32Array([0.1, 0.2]));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}

        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "这段转写只应该进 Codex", durationMs: 1 };
        }
      },
    }));

    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    await voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 76,
        voice: { file_id: "voice-private" },
        reply_to_message: { message_id: 75, text: "这是语音 Reply 的原消息" },
      },
      api: bot.api,
    });

    const voiceInput = session.prompt.mock.calls[0][0] as { text?: string; visibleText?: string };
    const codexInput = voiceInput.text ?? String(voiceInput);
    expect(voiceInput.visibleText).toBe("这段转写只应该进 Codex");
    expect(codexInput).toContain("[DEVELOPER DISCIPLINE]");
    expect(codexInput).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(codexInput).toContain("fix at the earliest reliable boundary");
    expect(codexInput).toContain("这段转写只应该进 Codex");
    expect(codexInput).toContain("[TELEGRAM REPLY CONTEXT]");
    expect(codexInput).toContain("这是语音 Reply 的原消息");
    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visibleReplies).toContain("我听到了。");
    expect(visibleReplies).not.toContain("Transcribed");
    expect(visibleReplies).not.toContain("这段转写只应该进 Codex");
  });

  it("queues voice transcripts behind an active text turn before calling Codex", async () => {
    const firstTurn = deferred<void>();
    let activePrompt = false;
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      if (activePrompt) {
        throw new Error("A Codex turn is already in progress");
      }

      activePrompt = true;
      promptCount += 1;
      try {
        if (promptCount === 1) {
          callbacks.onTextDelta("第一轮回复。");
          callbacks.onAgentMessage?.("第一轮回复。");
          await firstTurn.promise;
        } else {
          callbacks.onTextDelta("语音进入 Codex。");
          callbacks.onAgentMessage?.("语音进入 Codex。");
        }
        callbacks.onAgentEnd();
      } finally {
        activePrompt = false;
      }
    });
    session.isProcessing.mockImplementation(() => activePrompt);
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/queued.ogg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    _setDecodeHook(async () => new Float32Array([0.1, 0.2]));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}

        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "语音第二条必须排队", durationMs: 1 };
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 77, text: "第一条，先跑一个长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 78, voice: { file_id: "voice-queued" } },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).not.toContain(
      "A Codex turn is already in progress",
    );

    firstTurn.resolve();
    await firstPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("语音第二条必须排队");
  });

  it("places the style guard before staged file instructions for document prompts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-bot-doc-"));
    tempDirs.push(workspace);
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("文件收到了。");
      callbacks.onAgentMessage?.("文件收到了。");
      callbacks.onAgentEnd();
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/report.txt",
      file_size: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );
    const documentHandler = bot.__handlers.on.get("message:document");

    await documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 77,
        document: { file_id: "doc-file", file_name: "report.txt", mime_type: "text/plain", file_size: 5 },
        caption: "帮我总结",
      },
      api: bot.api,
    });

    const input = session.prompt.mock.calls[0][0] as { stagedFileInstructions?: string; text?: string };
    expect(input.stagedFileInstructions?.startsWith("[TELEGRAM REPLY STYLE]")).toBe(true);
    expect(input.stagedFileInstructions).toContain("[DEVELOPER DISCIPLINE]");
    expect(input.stagedFileInstructions).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(input.stagedFileInstructions).toContain("fix at the earliest reliable boundary");
    expect(input.stagedFileInstructions).toContain("[CURRENT CONTEXT]");
    expect(input.stagedFileInstructions).toContain("Current model: gpt-5.5");
    expect(input.stagedFileInstructions).toContain("Current reasoning effort: xhigh");
    expect(input.stagedFileInstructions).not.toMatch(/runtime facts/i);
    expect(input.stagedFileInstructions).toContain("staged on disk");
    expect(input.text).toContain("帮我总结");
    expect(input.text).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(input.text?.startsWith("帮我总结\n\n[CODEX EXEC ADAPTER OVERRIDE]")).toBe(true);
  });

  it("adds runtime facts to image prompts while preserving image paths", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("图片收到了。");
      callbacks.onAgentMessage?.("图片收到了。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "photos/example.jpg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    const photoHandler = bot.__handlers.on.get("message:photo");

    await photoHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 78,
        photo: [{ file_id: "small-photo" }],
        caption: "看一下这张图",
      },
      api: bot.api,
    });

    const input = session.prompt.mock.calls[0][0] as { imagePaths?: string[]; text?: string };
    expect(input.imagePaths).toHaveLength(1);
    expect(input.imagePaths?.[0]).toContain("telecodex-file-");
    expect(input.text).toContain("[DEVELOPER DISCIPLINE]");
    expect(input.text).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(input.text).toContain("fix at the earliest reliable boundary");
    expect(input.text).toContain("[CURRENT CONTEXT]");
    expect(input.text).toContain("Current model: gpt-5.5");
    expect(input.text).toContain("Current reasoning effort: xhigh");
    expect(input.text).not.toMatch(/runtime facts/i);
    expect(input.text).toContain("看一下这张图");
  });

  it("keeps refreshing typing after a streaming preview until the whole turn finishes (ALB-1361)", async () => {
    vi.useFakeTimers();
    try {
      let typingCallsDuringToolWait = -1;
      let botInstance: any;
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("收到，我查一下。");
        await Promise.resolve();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(9_000);
        typingCallsDuringToolWait = botInstance.api.sendChatAction.mock.calls.filter(
          (call: unknown[]) => call[1] === "typing",
        ).length;

        callbacks.onAgentMessage?.("查完了。");
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
      botInstance = mockGrammy.bots[0];
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 1361, text: "跑一个长工具任务" },
        api: bot.api,
      });

      expect(typingCallsDuringToolWait).toBeGreaterThanOrEqual(3);

      const typingCallsAfterTurn = bot.api.sendChatAction.mock.calls.filter(
        (call: unknown[]) => call[1] === "typing",
      ).length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(
        bot.api.sendChatAction.mock.calls.filter((call: unknown[]) => call[1] === "typing").length,
      ).toBe(typingCallsAfterTurn);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refreshing typing until the final Telegram reply is delivered (ALB-1361)", async () => {
    vi.useFakeTimers();
    try {
      let releaseFinalDelivery!: () => void;
      const finalDelivery = new Promise<void>((resolve) => {
        releaseFinalDelivery = resolve;
      });
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("收到，我查一下。");
        await Promise.resolve();
        await Promise.resolve();
        callbacks.onAgentMessage?.("查完了。");
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
      const botInstance = mockGrammy.bots[0];
      botInstance.api.sendMessage.mockImplementation(async () => {
        await finalDelivery;
        return { message_id: 1362 };
      });
      const textHandler = bot.__handlers.on.get("message:text");

      const turnPromise = textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 1362, text: "跑完以后再回我" },
        api: bot.api,
      });
      await vi.advanceTimersByTimeAsync(9_000);

      expect(
        bot.api.sendChatAction.mock.calls.filter((call: unknown[]) => call[1] === "typing").length,
      ).toBeGreaterThanOrEqual(3);

      releaseFinalDelivery();
      await turnPromise;

      const typingCallsAfterDelivery = bot.api.sendChatAction.mock.calls.filter(
        (call: unknown[]) => call[1] === "typing",
      ).length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(
        bot.api.sendChatAction.mock.calls.filter((call: unknown[]) => call[1] === "typing").length,
      ).toBe(typingCallsAfterDelivery);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refreshing typing until a failed turn reply is delivered (ALB-1361 review)", async () => {
    vi.useFakeTimers();
    try {
      let releaseFailureDelivery!: () => void;
      const failureDelivery = new Promise<void>((resolve) => {
        releaseFailureDelivery = resolve;
      });
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("处理中。");
        await Promise.resolve();
        await Promise.resolve();
        throw new Error("provider failed");
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
      const botInstance = mockGrammy.bots[0];
      botInstance.api.sendMessage.mockImplementation(async () => {
        await failureDelivery;
        return { message_id: 1363 };
      });
      const textHandler = bot.__handlers.on.get("message:text");

      const turnPromise = textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 1363, text: "失败也要准确显示工作状态" },
        api: bot.api,
      });
      await vi.advanceTimersByTimeAsync(9_000);

      expect(
        bot.api.sendChatAction.mock.calls.filter((call: unknown[]) => call[1] === "typing").length,
      ).toBeGreaterThanOrEqual(3);

      releaseFailureDelivery();
      await turnPromise;

      const typingCallsAfterDelivery = bot.api.sendChatAction.mock.calls.filter(
        (call: unknown[]) => call[1] === "typing",
      ).length;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(
        bot.api.sendChatAction.mock.calls.filter((call: unknown[]) => call[1] === "typing").length,
      ).toBe(typingCallsAfterDelivery);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends completed streaming agent messages as separate Telegram bubbles", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("第一段进度。");
      await callbacks.onAgentMessage?.("第一段进度。");
      await Promise.resolve();

      callbacks.onTextDelta("第二段结果。");
      await callbacks.onAgentMessage?.("第二段结果。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 8, text: "帮我查一下" },
      api: bot.api,
    });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain("第一段进度。");
    expect(bot.api.sendMessage.mock.calls[0][1]).not.toContain("第二段结果。");
    expect(bot.api.sendMessage.mock.calls[1][1]).toContain("第二段结果。");
    expect(bot.api.sendMessage.mock.calls[1][1]).not.toContain("第一段进度。");
  });

  it("continues with later streaming messages after a long-message chunk fails", async () => {
    const longProgress = "阶段".repeat(2_100);
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta(longProgress);
      callbacks.onAgentMessage?.(longProgress);
      callbacks.onTextDelta("最终结果。");
      callbacks.onAgentMessage?.("最终结果。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    bot.api.sendMessage
      .mockResolvedValueOnce({ message_id: 1 })
      .mockRejectedValueOnce(new Error("telegram chunk failed"));
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 10, text: "继续处理" },
      api: bot.api,
    });

    const sentTexts = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1]));
    expect(sentTexts[2]).toBe(sentTexts[1]);
    expect(sentTexts.filter((text: string) => text.includes("最终结果。"))).toHaveLength(1);
  });
  it("continues with later streaming messages after both delivery attempts fail", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("第一段永久失败。");
      callbacks.onAgentMessage?.("第一段永久失败。");
      callbacks.onTextDelta("后续结果仍要送达。");
      callbacks.onAgentMessage?.("后续结果仍要送达。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    bot.api.sendMessage
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockRejectedValueOnce(new Error("retry failed"));
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 12, text: "继续处理" },
      api: bot.api,
    });

    const sentTexts = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1]));
    expect(sentTexts.filter((text: string) => text.includes("第一段永久失败。"))).toHaveLength(2);
    expect(sentTexts.some((text: string) => text.includes("有一段回复发送失败"))).toBe(true);
    expect(sentTexts.filter((text: string) => text.includes("后续结果仍要送达。"))).toHaveLength(1);
  });

  it("waits for queued streaming delivery before finishing a failed turn", async () => {
    const releaseDelivery = deferred<void>();
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("已完成的阶段进度。");
      callbacks.onAgentMessage?.("已完成的阶段进度。");
      throw new Error("provider failed");
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    bot.api.sendMessage.mockImplementationOnce(async () => {
      await releaseDelivery.promise;
      return { message_id: 1 };
    });
    const textHandler = bot.__handlers.on.get("message:text");

    let settled = false;
    const handling = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 11, text: "继续处理" },
      api: bot.api,
    }).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    releaseDelivery.resolve();
    await handling;
    expect(settled).toBe(true);
  });
  it("keeps the typing heartbeat active after a completed progress bubble appears", async () => {
    vi.useFakeTimers();
    try {
      let messagesAfterProgress = -1;
      let actionsAfterPreview = -1;
      let actionsAfterWorking = -1;
      let botInstance: any;
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("阶段进度。");
        callbacks.onAgentMessage?.("阶段进度。");
        await Promise.resolve();
        await Promise.resolve();
        messagesAfterProgress = botInstance.api.sendMessage.mock.calls.length;
        actionsAfterPreview = botInstance.api.sendChatAction.mock.calls.length;

        await vi.advanceTimersByTimeAsync(10_000);
        actionsAfterWorking = botInstance.api.sendChatAction.mock.calls.length;

        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
      botInstance = mockGrammy.bots[0];
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 9, text: "继续处理" },
        api: bot.api,
      });

      expect(messagesAfterProgress).toBeGreaterThan(0);
      expect(actionsAfterPreview).toBeGreaterThan(0);
      expect(actionsAfterWorking).toBeGreaterThan(actionsAfterPreview);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not expose echoed developer discipline in streaming previews", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta(
        [
          "[DEVELOPER DISCIPLINE]",
          "discipline_version=ALB-714-hard-discipline-v1",
          "Fix root cause: explain why a bug happened before fixing it, then fix at the earliest reliable boundary.",
          "",
          "流式回复。",
        ].join("\n"),
      );
      await Promise.resolve();
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 81, text: "只要流式结论" },
      api: bot.api,
    });

    const visible = [
      ...bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])),
      ...bot.api.editMessageText.mock.calls.map((call: unknown[]) => String(call[2])),
    ].join("\n");
    expect(visible).toContain("流式回复。");
    expect(visible).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(visible).not.toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(visible).not.toContain("Fix root cause");
  });

  it("passes Telegram Reply source text together with the new message", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("看到了引用。");
      callbacks.onAgentMessage?.("看到了引用。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 899,
        text: "这是我现在的新问题",
        reply_to_message: {
          message_id: 898,
          text: "这是我长按 Reply 的原消息",
          from: { id: 321, first_name: "Ada" },
        },
      },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const replyInput = session.prompt.mock.calls[0][0] as { text?: string; visibleText?: string };
    expect(replyInput.visibleText).toBe("这是我现在的新问题");
    const input = replyInput.text ?? String(replyInput);
    expect(input).toContain("[TELEGRAM REPLY CONTEXT]");
    expect(input).toContain("这是我长按 Reply 的原消息");
    expect(input).toContain("[CURRENT MESSAGE]");
    expect(input).toContain("这是我现在的新问题");
    expect(input).not.toContain("Replied sender");
    expect(input).not.toContain("Replied message id");
    expect(input).not.toContain("Ada");
  });

  it("keeps current-message source preferences separate from replied text", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("结论。\n\n来源：\nhttps://example.com/old");
      callbacks.onAgentMessage?.("结论。\n\n来源：\nhttps://example.com/old");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 897,
        text: "这次不要来源",
        reply_to_message: { message_id: 896, text: "请给我来源" },
      },
      api: bot.api,
    });

    const visible = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visible).toContain("结论。");
    expect(visible).not.toContain("https://example.com/old");

    const retryHandler = bot.__handlers.commands.get("retry");
    await retryHandler({
      chat: { id: 42 }, from: { id: 123 },
      message: { message_id: 898, text: "/retry" },
      api: bot.api,
    });
    const retried = session.prompt.mock.calls[1][0] as { text?: string; visibleText?: string };
    expect(retried.visibleText).toBe("这次不要来源");
    expect(retried.text).toContain("请给我来源");
  });

  it("passes replied captions as Reply context", async () => {
    const session = createSession(async (callbacks) => { callbacks.onAgentEnd(); });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    await textHandler({
      chat: { id: 42 }, from: { id: 123 },
      message: { message_id: 895, text: "看这条", reply_to_message: { message_id: 894, caption: "原图说明" } },
      api: bot.api,
    });
    const replyInput = session.prompt.mock.calls[0][0] as { text?: string };
    expect(replyInput.text).toContain("原图说明");
  });

  it("thin bridge sends each text message immediately without dispatcher coalescing", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("即时回复。");
        callbacks.onAgentMessage?.("即时回复。");
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ telegramTextCoalesceMs: 60_000 } as any), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 900, text: "不要合并，马上进 Codex" },
        api: bot.api,
      });

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(String(session.prompt.mock.calls[0][0])).toContain("不要合并，马上进 Codex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("thin bridge queues a text follow-up instead of sending a dispatcher busy reply", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("第二轮进入 Codex。");
        callbacks.onAgentMessage?.("第二轮进入 Codex。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 901, text: "第一条，先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const secondPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 902, text: "第二条，照常送进 Codex" },
      api: bot.api,
    });

    expect(session.abort).not.toHaveBeenCalled();
    await delay(20);
    expect(session.prompt).toHaveBeenCalledTimes(1);

    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\\n");
    expect(visibleReplies).not.toContain("Still working on previous message");

    firstTurn.resolve();
    await firstPromise;
    await secondPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条，照常送进 Codex");
  });

  it("does not fail startup when Telegram command registration is rate limited", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("ok");
      callbacks.onAgentMessage?.("ok");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.setMyCommands.mockRejectedValueOnce(
      new Error("Call to setMyCommands failed! (429: Too Many Requests: retry after 1151)"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(registerCommands(bot)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Failed to register Telegram bot commands"),
        expect.stringContaining("Rate limited by the API"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("requeues a text prompt when the Codex session boundary reports an active turn race", async () => {
    let firstRejected = false;
    let externalBusy = false;
    const session = createSession(async (callbacks, input) => {
      if (!firstRejected) {
        firstRejected = true;
        externalBusy = true;
        throw new Error("A Codex turn is already in progress");
      }

      callbacks.onTextDelta("排队后进入 Codex。");
      callbacks.onAgentMessage?.("排队后进入 Codex。");
      callbacks.onAgentEnd();
    });
    session.isProcessing.mockImplementation(() => externalBusy);
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 905, text: "这条不能露 busy，要等边界空出来" },
      api: bot.api,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\\n")).not.toContain(
      "A Codex turn is already in progress",
    );

    externalBusy = false;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("这条不能露 busy");
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\\n")).toContain(
      "排队后进入 Codex",
    );
  });

  it("serializes same-context text follow-ups before calling Codex", async () => {
    const firstTurn = deferred<void>();
    let activePrompt = false;
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      if (activePrompt) {
        throw new Error("A Codex turn is already in progress");
      }

      activePrompt = true;
      promptCount += 1;
      try {
        if (promptCount === 1) {
          callbacks.onTextDelta("第一轮回复。");
          callbacks.onAgentMessage?.("第一轮回复。");
          await firstTurn.promise;
        } else {
          callbacks.onTextDelta("第二轮进入 Codex。");
          callbacks.onAgentMessage?.("第二轮进入 Codex。");
        }
        callbacks.onAgentEnd();
      } finally {
        activePrompt = false;
      }
    });
    session.isProcessing.mockImplementation(() => activePrompt);
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 903, text: "第一条，先跑一个长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const secondPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 904, text: "第二条必须等第一条结束再进 Codex" },
      api: bot.api,
    });

    await delay(20);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).not.toContain(
      "A Codex turn is already in progress",
    );

    firstTurn.resolve();
    await firstPromise;
    await secondPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条必须等第一条结束再进 Codex");
  });

  it("pending-answer guard: a normally answered message triggers no re-prompt (ALB-1339 场景①)", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("这就是答复。");
      callbacks.onAgentMessage?.("这就是答复。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1101, text: "普通一问" },
      api: bot.api,
    });
    await delay(30);

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const allPrompts = session.prompt.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(allPrompts).not.toContain("欠答自查");
  });

  it("pending-answer guard: queued messages answered by their own turns are all struck (ALB-1339 场景②)", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第${promptCount}轮回复。`);
        callbacks.onAgentMessage?.(`第${promptCount}轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1111, text: "第一条，长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const secondPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1112, text: "第二条，排队" },
      api: bot.api,
    });
    const thirdPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1113, text: "第三条，也排队" },
      api: bot.api,
    });

    firstTurn.resolve();
    await Promise.all([firstPromise, secondPromise, thirdPromise]);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    await delay(300);

    // All three were answered by their own turns — nothing is owed, no re-prompt.
    expect(session.prompt).toHaveBeenCalledTimes(3);
    const allPrompts = session.prompt.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(allPrompts).not.toContain("欠答自查");
  });

  it("pending-answer guard: a swallowed message is re-prompted once on the next finalize (ALB-1339 场景③)", async () => {
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        // The turn for the first message dies without ever answering it.
        throw new Error("codex exploded mid-turn");
      }
      callbacks.onTextDelta(`第${promptCount}轮回复。`);
      callbacks.onAgentMessage?.(`第${promptCount}轮回复。`);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1121, text: "这条会被吞掉，一直没人答" },
      api: bot.api,
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1122, text: "第二条正常问" },
      api: bot.api,
    });

    // Second turn answers normally, then its finalize notices the swallowed
    // first message and feeds a re-prompt turn back into the same thread.
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const repromptText = String(session.prompt.mock.calls[2][0]);
    expect(repromptText).toContain("欠答自查");
    expect(repromptText).toContain("这条会被吞掉，一直没人答");
  });

  it("pending-answer guard: the re-prompt turn itself never spawns another re-prompt (ALB-1339 场景④)", async () => {
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        throw new Error("codex exploded mid-turn");
      }
      callbacks.onTextDelta(`第${promptCount}轮回复。`);
      callbacks.onAgentMessage?.(`第${promptCount}轮回复。`);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1131, text: "被吞的一条" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1132, text: "触发补答的一条" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    await delay(400);

    // Exactly one re-prompt across the whole exchange, and it does not loop.
    expect(session.prompt).toHaveBeenCalledTimes(3);
    const repromptCalls = session.prompt.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("欠答自查"),
    );
    expect(repromptCalls).toHaveLength(1);
  });

  it("pending-answer guard: a message arriving mid-turn is not treated as owed (ALB-1339 场景⑤)", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("第二轮回复。");
        callbacks.onAgentMessage?.("第二轮回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1141, text: "第一条，长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    // Arrives while turn 1 is still running: queued, not owed by turn 1.
    const secondPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1142, text: "turn 进行中来的一条" },
      api: bot.api,
    });

    firstTurn.resolve();
    await Promise.all([firstPromise, secondPromise]);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    await delay(300);

    expect(session.prompt).toHaveBeenCalledTimes(2);
    const allPrompts = session.prompt.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(allPrompts).not.toContain("欠答自查");
  });

  it("pending-answer guard: a successful /retry strikes the original message instead of re-prompting it (ALB-1339 review fix)", async () => {
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        // Message A's own turn dies without answering it.
        throw new Error("codex exploded mid-turn");
      }
      callbacks.onTextDelta(`第${promptCount}轮回复。`);
      callbacks.onAgentMessage?.(`第${promptCount}轮回复。`);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const bot = createBot(createConfig(), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const retryCommand = bot.__handlers.commands.get("retry");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1151, text: "消息A，第一轮会挂" },
      api: bot.api,
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);

    // /retry re-runs A's cached content and succeeds: A is answered — its
    // ledger debt must be struck via the cached msgId, not re-prompted.
    await retryCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 1152, text: "/retry" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    await delay(400);

    expect(session.prompt).toHaveBeenCalledTimes(2);
    const allPrompts = session.prompt.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(allPrompts).not.toContain("欠答自查");
  });

});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reactionEmojiFromCall(call: unknown[] | undefined): string | undefined {
  const reactions = call?.[2] as Array<{ emoji?: string }> | undefined;
  return reactions?.[0]?.emoji;
}

describe("registerCommands startup resilience", () => {
  it("does not reject when Telegram command registration is rate limited", async () => {
    const bot = {
      api: {
        setMyCommands: vi.fn().mockRejectedValue(new Error("429: Too Many Requests: retry after 120")),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(registerCommands(bot as any)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Failed to register Telegram bot commands"),
      expect.stringContaining("Rate limited by the API"),
    );
    warn.mockRestore();
  });
});
