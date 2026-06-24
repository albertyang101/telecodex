import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
import { ForegroundTextPromptQueue } from "../src/foreground-prompt-queue.js";

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

import { createBot } from "../src/bot.js";
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
    telegramTextCoalesceMs: 0,
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
    ...overrides,
  });

  const createSession = (
    onPrompt: (callbacks: CodexSessionCallbacks, input: unknown) => Promise<void>,
  ) => ({
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    newThread: vi.fn(),
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
    mockAuth.startLogin.mockResolvedValue({
      success: true,
      message: "login started",
    });
    mockAuth.startLogout.mockReset();
    mockAuth.startLogout.mockResolvedValue({
      success: true,
      message: "logged out",
    });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "parakeet";
    process.env.QWEN_ASR_SOCKET = "/tmp/telecodex-test-missing-qwen-asr.sock";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    _resetImportHook();
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

  afterAll(async () => {
    await delay(25);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

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

  it("does not expose partial source headings in streaming previews", async () => {
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

    expect(sendsBeforeAgentEnd).toBe(1);
    const firstVisible = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(firstVisible).toContain("结论是配置问题。");
    expect(firstVisible).not.toContain("来源");
  });

  it("does not expose source footers in streaming previews", async () => {
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

    expect(sendsBeforeAgentEnd).toBe(1);
    const firstVisible = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(firstVisible).toContain("巴黎下周会比墨尔本热很多");
    expect(firstVisible).not.toContain("来源");
    expect(firstVisible).not.toContain("https://");
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
      message: { message_id: 76, voice: { file_id: "voice-private" } },
      api: bot.api,
    });

    const codexInput = String(session.prompt.mock.calls[0][0]);
    expect(codexInput).toContain("[DEVELOPER DISCIPLINE]");
    expect(codexInput).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(codexInput).toContain("fix at the earliest reliable boundary");
    expect(codexInput).toContain("这段转写只应该进 Codex");
    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visibleReplies).toContain("我听到了。");
    expect(visibleReplies).not.toContain("Transcribed");
    expect(visibleReplies).not.toContain("这段转写只应该进 Codex");
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

  it("keeps streaming agent deltas when response streaming is enabled", async () => {
    let sendsBeforeAgentEnd = -1;
    let botInstance: any;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("流式预览。");
      await Promise.resolve();
      sendsBeforeAgentEnd = botInstance.api.sendMessage.mock.calls.length;

      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ streamAgentResponses: true }), registry as any) as any;
    botInstance = mockGrammy.bots[0];
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 8, text: "帮我查一下" },
      api: bot.api,
    });

    expect(sendsBeforeAgentEnd).toBe(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage.mock.calls[0][1]).toContain("流式预览。");
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

  it("queues text follow-ups that arrive while a Codex turn is still running", async () => {
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
      message: { message_id: 10, text: "第一条，先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 11, text: "第二条，必须排队进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条，必须排队进 Codex");
    expect(String(session.prompt.mock.calls[1][0])).toContain("[DEVELOPER DISCIPLINE]");
    expect(String(session.prompt.mock.calls[1][0])).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).not.toContain(
      "Still working on previous message",
    );
  });

  it("interrupts an active text turn and merges consecutive follow-ups into one next Codex turn", async () => {
    vi.useFakeTimers();
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮半截输出，不应该发到 Telegram。");
        callbacks.onAgentMessage?.("第一轮半截输出，不应该发到 Telegram。");
        await firstTurn.promise;
        throw new Error("The operation was aborted");
      }

      callbacks.onTextDelta("合并后回复。");
      callbacks.onAgentMessage?.("合并后回复。");
      callbacks.onAgentEnd();
    });
    session.abort.mockImplementation(async () => {
      firstTurn.resolve();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ telegramTextCoalesceMs: 25 }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 210, text: "第一条，先跑一个长任务" },
      api: bot.api,
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 211, text: "第二条：别继续上一条了" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 212, text: "第三条：按这两条一起处理" },
      api: bot.api,
    });

    try {
      await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1), { timeout: 100 });
      await firstPromise;
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));

      const secondPrompt = String(session.prompt.mock.calls[1][0]);
      expect(secondPrompt).toContain("第二条：别继续上一条了");
      expect(secondPrompt).toContain("第三条：按这两条一起处理");
      expect(secondPrompt.indexOf("第二条：别继续上一条了")).toBeLessThan(
        secondPrompt.indexOf("第三条：按这两条一起处理"),
      );

      const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
      expect(visibleReplies).toContain("合并后回复。");
      expect(visibleReplies).not.toContain("第一轮半截输出");
      expect(visibleReplies).not.toContain("Aborted");
      expect(visibleReplies).not.toContain("Request timed out");
    } finally {
      firstTurn.resolve();
      await firstPromise;
      vi.useRealTimers();
    }
  });

  it("removes durable text that is superseded by a follow-up instead of replaying the old turn", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-superseded-remove-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("old partial");
        await firstTurn.promise;
        throw new Error("The operation was aborted");
      }

      callbacks.onTextDelta("new reply");
      callbacks.onAgentMessage?.("new reply");
      callbacks.onAgentEnd();
    });
    session.abort.mockImplementation(async () => {
      firstTurn.resolve();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, telegramTextCoalesceMs: 25 }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 425, text: "old instruction that gets superseded" },
      api: bot.api,
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 426, text: "new instruction replaces it" },
      api: bot.api,
    });

    try {
      await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1), { timeout: 100 });
      await firstPromise;
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
      await waitForForegroundQueueEmpty(workspace);
    } finally {
      firstTurn.resolve();
      await firstPromise;
      vi.useRealTimers();
    }
  });

  it("removes a durable text prompt after sending a visible non-timeout failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-visible-failure-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const session = createSession(async () => {
      throw new Error("provider exploded");
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 427, text: "this should fail visibly once" },
      api: bot.api,
    });

    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).toContain(
      "provider exploded",
    );
    await waitForForegroundQueueEmpty(workspace);
  });

  it("removes durable text after a visible final answer even if Codex rejects during cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-finalized-reject-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("visible final answer");
      callbacks.onAgentMessage?.("visible final answer");
      callbacks.onAgentEnd();
      throw new Error("cleanup failed after final answer");
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 436, text: "this receives a final answer before cleanup fails" },
      api: bot.api,
    });

    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visibleReplies).toContain("visible final answer");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("deletes an already streamed partial reply when a text follow-up interrupts the active turn", async () => {
    vi.useFakeTimers();
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮半截 streaming 输出，不应该留在 Telegram。");
        await firstTurn.promise;
        throw new Error("The operation was aborted");
      }

      callbacks.onTextDelta("合并后回复。");
      callbacks.onAgentMessage?.("合并后回复。");
      callbacks.onAgentEnd();
    });
    session.abort.mockImplementation(async () => {
      firstTurn.resolve();
    });
    const registry = createRegistry(session);

    const bot = createBot(
      createConfig({ streamAgentResponses: true, telegramTextCoalesceMs: 25 }),
      registry as any,
    ) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 214, text: "第一条，先开始 streaming 长任务" },
      api: bot.api,
    });
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).toContain(
        "第一轮半截 streaming 输出",
      ),
    );

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 215, text: "第二条：打断上一条" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 216, text: "第三条：按这两条一起处理" },
      api: bot.api,
    });

    try {
      await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1), { timeout: 100 });
      await vi.waitFor(() => expect(bot.api.deleteMessage).toHaveBeenCalledWith(42, expect.any(Number)));
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));

      const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
      expect(visibleReplies).toContain("合并后回复。");
      expect(visibleReplies).not.toContain("Request timed out");
    } finally {
      firstTurn.resolve();
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of text messages from the same Telegram user into one Codex turn", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("合并后的回复。");
        callbacks.onAgentMessage?.("合并后的回复。");
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ telegramTextCoalesceMs: 25 }), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 92, text: "第一段：先说明背景" },
        api: bot.api,
      });
      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 93, text: "第二段：补充约束" },
        api: bot.api,
      });
      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 94, text: "第三段：最后的问题" },
        api: bot.api,
      });

      expect(session.prompt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);

      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
      const prompt = String(session.prompt.mock.calls[0][0]);
      expect(prompt).toContain("第一段：先说明背景");
      expect(prompt).toContain("第二段：补充约束");
      expect(prompt).toContain("第三段：最后的问题");
      expect(prompt.indexOf("第一段：先说明背景")).toBeLessThan(prompt.indexOf("第二段：补充约束"));
      expect(prompt.indexOf("第二段：补充约束")).toBeLessThan(prompt.indexOf("第三段：最后的问题"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending coalesced text when Albert aborts before the turn is sent to Codex", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("不应执行。");
        callbacks.onAgentMessage?.("不应执行。");
        callbacks.onAgentEnd();
      });
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ telegramTextCoalesceMs: 25 }), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");
      const abortCommand = bot.__handlers.commands.get("abort");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 95, text: "这条还在 coalescing window 里，abort 后不能进 Codex" },
        api: bot.api,
      });

      await abortCommand({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 96, text: "/abort" },
        api: bot.api,
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).toContain(
        "Aborted current operation",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a pending coalesced text turn as busy before state-changing commands run", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("待处理文本回复。");
        callbacks.onAgentMessage?.("待处理文本回复。");
        callbacks.onAgentEnd();
      });
      (session as any).listWorkspaces = vi.fn(() => [defaultWorkspace]);
      session.newThread.mockResolvedValue(session.getInfo());
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ telegramTextCoalesceMs: 25 }), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");
      const newCommand = bot.__handlers.commands.get("new");

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 95, text: "这条还在 coalescing window 里" },
        api: bot.api,
      });

      await newCommand({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 96, text: "/new" },
        api: bot.api,
      });

      expect(session.newThread).not.toHaveBeenCalled();
      expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).toContain(
        "Cannot create a new thread while a prompt is running.",
      );

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
      expect(String(session.prompt.mock.calls[0][0])).toContain("这条还在 coalescing window 里");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats pending coalesced text as busy before effort callback changes session state", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession(async (callbacks) => {
        callbacks.onTextDelta("待处理文本回复。");
        callbacks.onAgentMessage?.("待处理文本回复。");
        callbacks.onAgentEnd();
      });
      (session as any).setReasoningEffort = vi.fn();
      const registry = createRegistry(session);

      const bot = createBot(createConfig({ telegramTextCoalesceMs: 25 }), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");
      const effortCommand = bot.__handlers.commands.get("effort");
      const effortCallback = bot.__handlers.callbacks.find(
        (callback: any) => typeof callback.pattern?.test === "function" && callback.pattern.test("effort_xhigh"),
      )?.handler;
      const answerCallbackQuery = vi.fn();

      await effortCommand({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 97, text: "/effort" },
        api: bot.api,
      });

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 98, text: "这条 pending 文本应挡住 effort callback" },
        api: bot.api,
      });

      await effortCallback({
        chat: { id: 42 },
        from: { id: 123 },
        callbackQuery: { message: { message_id: 99 } },
        match: ["effort_xhigh", "xhigh"],
        answerCallbackQuery,
        api: bot.api,
      });

      expect((session as any).setReasoningEffort).not.toHaveBeenCalled();
      expect(answerCallbackQuery).toHaveBeenCalledWith({ text: "Wait for the current prompt to finish" });

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
      expect(String(session.prompt.mock.calls[0][0])).toContain("这条 pending 文本应挡住 effort callback");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending coalesced text reactions when a session context is removed", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("不应执行。");
      callbacks.onAgentMessage?.("不应执行。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session) as any;

    const bot = createBot(createConfig({ enableTelegramReactions: true, telegramTextCoalesceMs: 60_000 }), registry) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 97, text: "这条会在 remove 前被取消" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(reactionEmojiFromCall(bot.api.setMessageReaction.mock.calls[0])).toBe("👀"));

    registry.__removeCallbacks[0]("42");

    await vi.waitFor(() => expect(bot.api.setMessageReaction).toHaveBeenCalledWith(42, 97, []));
    await delay(20);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("flushes earlier pending text from another Telegram user before media in the same context", async () => {
    const finishPhotoDownload = deferred<ArrayBuffer>();
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("图片回复。");
      callbacks.onAgentMessage?.("图片回复。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session) as any;

    const bot = createBot(
      createConfig({
        telegramAllowedUserIds: [123, 456],
        telegramAllowedUserIdSet: new Set([123, 456]),
        telegramTextCoalesceMs: 60_000,
      }),
      registry,
    ) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "photos/cross-user.jpg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => finishPhotoDownload.promise,
      })),
    );
    const textHandler = bot.__handlers.on.get("message:text");
    const photoHandler = bot.__handlers.on.get("message:photo");

    await textHandler({
      chat: { id: -1001 },
      from: { id: 123 },
        message: { message_id: 98, text: "用户 A 的 pending 文本必须排在用户 B 的图片前" },
        api: bot.api,
      });

    const photoPromise = photoHandler({
      chat: { id: -1001 },
      from: { id: 456 },
      message: {
        message_id: 99,
        photo: [{ file_id: "photo-file-cross-user" }],
      },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("用户 A 的 pending 文本必须排在用户 B 的图片前");

    finishPhotoDownload.resolve(new Uint8Array([1, 2, 3]).buffer);
    await photoPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    const secondInput = session.prompt.mock.calls[1][0] as { imagePaths?: string[] };
    expect(secondInput.imagePaths).toHaveLength(1);
    registry.__removeCallbacks[0]("-1001");
  });

  it("flushes the same Telegram user's pending text before media in the same context", async () => {
    const finishPhotoDownload = deferred<ArrayBuffer>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session) as any;

    const bot = createBot(createConfig({ telegramTextCoalesceMs: 60_000 }), registry) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "photos/same-user.jpg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => finishPhotoDownload.promise,
      })),
    );
    const textHandler = bot.__handlers.on.get("message:text");
    const photoHandler = bot.__handlers.on.get("message:photo");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 100, text: "同一用户的 pending 文本必须排在图片前" },
      api: bot.api,
    });

    const photoPromise = photoHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 101,
        photo: [{ file_id: "photo-file-same-user" }],
      },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("同一用户的 pending 文本必须排在图片前");

    finishPhotoDownload.resolve(new Uint8Array([1, 2, 3]).buffer);
    await photoPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    const secondInput = session.prompt.mock.calls[1][0] as { imagePaths?: string[] };
    expect(secondInput.imagePaths).toHaveLength(1);
  });

  it("aborts a stuck foreground Codex turn after the configured timeout and drains queued prompts", async () => {
    vi.useFakeTimers();
    const abortCalled = deferred<void>();
    const releaseAbortedTurn = deferred<void>();
    const abortedTurnSettled = deferred<void>();
    let promptCount = 0;
    let processing = false;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      processing = true;
      if (promptCount === 1) {
        await abortCalled.promise;
        await releaseAbortedTurn.promise;
        processing = false;
        abortedTurnSettled.resolve();
        throw new Error("The operation was aborted");
      }

      try {
        callbacks.onTextDelta("第二轮回复。");
        callbacks.onAgentMessage?.("第二轮回复。");
        callbacks.onAgentEnd();
      } finally {
        processing = false;
      }
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockImplementation(async () => {
      abortCalled.resolve();
    });
    const registry = createRegistry(session);

    try {
      const bot = createBot(createConfig({ codexTurnTimeoutMs: 10_000 } as any), registry as any) as any;
      const textHandler = bot.__handlers.on.get("message:text");

      const firstPromise = textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 12, text: "第一条会卡住" },
        api: bot.api,
      });

      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

      await textHandler({
        chat: { id: 42 },
        from: { id: 123 },
        message: { message_id: 13, text: "第二条必须在超时后继续进 Codex" },
        api: bot.api,
      });
      await vi.advanceTimersByTimeAsync(10_000);

      await firstPromise;

      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(session.prompt).toHaveBeenCalledTimes(1);
      releaseAbortedTurn.resolve();
      await abortedTurnSettled.promise;
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
      expect(String(session.prompt.mock.calls[1][0])).toContain("第二条必须在超时后继续进 Codex");
      const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
      expect(visibleReplies).toContain("第二轮回复。");
      expect(visibleReplies).not.toContain("Request timed out. Try a shorter prompt or use /retry.");
    } finally {
      releaseAbortedTurn.resolve();
      vi.useRealTimers();
    }
  });

  it("does not append partial Codex output to timeout failure replies", async () => {
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("半截内部输出，不应该跟 timeout 一起发出来。");
      callbacks.onAgentMessage?.("半截内部输出，不应该跟 timeout 一起发出来。");
      await new Promise(() => {});
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ codexTurnTimeoutMs: 5 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 213, text: "这条会超时" },
      api: bot.api,
    });

    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(visibleReplies).toContain("Request timed out. Try a shorter prompt or use /retry.");
    expect(visibleReplies).not.toContain("半截内部输出");
  });

  it("still sends a timeout failure when no newer input exists and the aborted session is still active", async () => {
    let processing = false;
    const session = createSession(async (callbacks) => {
      processing = true;
      callbacks.onTextDelta("半截 active timeout 输出，不应该跟 timeout 一起发出来。");
      callbacks.onAgentMessage?.("半截 active timeout 输出，不应该跟 timeout 一起发出来。");
      await new Promise(() => {});
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockImplementation(async () => {
      processing = true;
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ codexTurnTimeoutMs: 5 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 217, text: "这条会超时，且没有 follow-up" },
      api: bot.api,
    });

    const visibleReplies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(visibleReplies).toContain("Request timed out. Try a shorter prompt or use /retry.");
    expect(visibleReplies).not.toContain("半截 active timeout 输出");
  });

  it("escalates to fatal recovery when a timed-out Codex turn never settles after abort", async () => {
    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const registry = createRegistry(session);
    const onFatalRecovery = vi.fn();

    const bot = createBot(
      createConfig({ codexTurnTimeoutMs: 5, codexTurnAbortGraceMs: 5 } as any),
      registry as any,
      { onFatalRecovery },
    ) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 14, text: "第一条会超时且 abort 后永不 settle" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await firstPromise;
    await vi.waitFor(() => expect(onFatalRecovery).toHaveBeenCalledTimes(1));

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(String(onFatalRecovery.mock.calls[0]?.[0]?.message)).toContain(
      "Codex turn remained active after timeout abort grace",
    );
  });

  it("persists text follow-ups queued behind a stuck timed-out turn before recovery can restart the process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, codexTurnTimeoutMs: 5 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 301, text: "第一条会超时且 session 不释放" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await firstPromise;

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 302, text: "第二条不能只放内存队列，否则重启会丢" },
      api: bot.api,
    });

    const queuePath = path.join(workspace, ".telecodex", "foreground_text_prompts.json");
    const queue = JSON.parse(await readFile(queuePath, "utf8"));
    expect(queue.entries["42:302"]).toMatchObject({
      contextKey: "42",
      chatId: 42,
      fromId: 123,
      messageId: 302,
      text: "第二条不能只放内存队列，否则重启会丢",
      status: "processing",
    });
  });

  it("persists coalesced text immediately when Telegram delivers it, before the coalescing timer fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not run yet");
      callbacks.onAgentMessage?.("should not run yet");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, telegramTextCoalesceMs: 60_000 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 303, text: "这条在 coalescing window 里也必须已经 durable" },
      api: bot.api,
    });

    const queue = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(queue.entries["42:303"]).toMatchObject({
      status: "processing",
      text: "这条在 coalescing window 里也必须已经 durable",
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("heartbeats a long coalescing durable text claim so another startup replay does not steal it", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("coalesced reply");
      callbacks.onAgentMessage?.("coalesced reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, telegramTextCoalesceMs: 60_000 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 431, text: "long coalesce must stay owned" },
      api: bot.api,
    });

    const queuePath = path.join(workspace, ".telecodex", "foreground_text_prompts.json");
    const claimedQueue = JSON.parse(await readFile(queuePath, "utf8"));
    claimedQueue.entries["42:431"].claimProcessId = 1;
    claimedQueue.entries["42:431"].updatedAt = Date.now() - 31_000;
    await writeFile(queuePath, `${JSON.stringify(claimedQueue, null, 2)}\n`, "utf8");

    await vi.advanceTimersByTimeAsync(10_000);
    const replaySession = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not replay");
      callbacks.onAgentMessage?.("should not replay");
      callbacks.onAgentEnd();
    });
    createBot(createConfig({ workspace } as any), createRegistry(replaySession) as any);
    await vi.advanceTimersByTimeAsync(20);

    try {
      expect(replaySession.prompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeats durable text while it is queued behind a stuck active turn so startup replay does not steal it", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queued-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const releaseFirstTurn = deferred<void>();
    let promptCalls = 0;
    const activeSession = createSession(async (callbacks) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        await releaseFirstTurn.promise;
        callbacks.onTextDelta("first done");
        callbacks.onAgentMessage?.("first done");
        callbacks.onAgentEnd();
        return;
      }
      callbacks.onTextDelta("queued done");
      callbacks.onAgentMessage?.("queued done");
      callbacks.onAgentEnd();
    });
    activeSession.abort.mockResolvedValue(undefined);
    const activeBot = createBot(createConfig({ workspace } as any), createRegistry(activeSession) as any) as any;
    const textHandler = activeBot.__handlers.on.get("message:text");

    const activePrompt = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 432, text: "active turn blocks the queue" },
      api: activeBot.api,
    });
    await vi.waitFor(() => expect(activeSession.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 433, text: "queued durable text must stay owned" },
      api: activeBot.api,
    });

    const queuePath = path.join(workspace, ".telecodex", "foreground_text_prompts.json");
    const claimedQueue = JSON.parse(await readFile(queuePath, "utf8"));
    claimedQueue.entries["42:433"].claimProcessId = 1;
    claimedQueue.entries["42:433"].updatedAt = Date.now() - 31_000;
    await writeFile(queuePath, `${JSON.stringify(claimedQueue, null, 2)}\n`, "utf8");

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () => {
        const queue = JSON.parse(await readFile(queuePath, "utf8"));
        expect(queue.entries["42:433"].updatedAt).toBeGreaterThan(Date.now() - 30_000);
      }, { timeout: 100 });

      releaseFirstTurn.resolve();
      await activePrompt;
      await waitForForegroundQueueEmpty(workspace);
    } finally {
      releaseFirstTurn.resolve();
      await activePrompt;
      vi.useRealTimers();
    }
  });

  it("keeps a durable text prompt after timeout instead of deleting it before recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-timeout-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, codexTurnTimeoutMs: 5 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 304, text: "这条 timeout 后必须留给 recovery" },
      api: bot.api,
    });

    const queue = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(queue.entries["42:304"]).toMatchObject({
      text: "这条 timeout 后必须留给 recovery",
      status: "pending",
    });
  });

  it("replays stale durable text prompts on startup after launchd recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:401": {
              id: "42:401",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 401,
              text: "这是 launchd recovery 后必须自动重放的消息",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("recovered reply");
      callbacks.onAgentMessage?.("recovered reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    createBot(createConfig({ workspace } as any), registry as any);

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1), { timeout: 100 });
    expect(String(session.prompt.mock.calls[0][0])).toContain("这是 launchd recovery 后必须自动重放的消息");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("heartbeats startup replay claims while session lookup is still scheduling", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-replay-scheduling-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:443": {
              id: "42:443",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 443,
              text: "startup replay claim must heartbeat before enqueue",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayLookupStarted = deferred<void>();
    const releaseReplayLookup = deferred<void>();
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("recovered reply");
      callbacks.onAgentMessage?.("recovered reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      replayLookupStarted.resolve();
      await releaseReplayLookup.promise;
      return session;
    });

    createBot(createConfig({ workspace } as any), registry as any);
    await replayLookupStarted.promise;
    const queuePath = path.join(queueDir, "foreground_text_prompts.json");
    const claimedQueue = JSON.parse(await readFile(queuePath, "utf8"));
    expect(claimedQueue.entries["42:443"]).toMatchObject({
      status: "processing",
      attempts: 1,
    });
    claimedQueue.entries["42:443"].updatedAt = Date.now() - 31_000;
    await writeFile(queuePath, `${JSON.stringify(claimedQueue, null, 2)}\n`, "utf8");

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () => {
        const queue = JSON.parse(await readFile(queuePath, "utf8"));
        expect(queue.entries["42:443"].updatedAt).toBeGreaterThan(Date.now() - 30_000);
      }, { timeout: 100 });

      releaseReplayLookup.resolve();
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
      await waitForForegroundQueueEmpty(workspace);
    } finally {
      releaseReplayLookup.resolve();
      vi.useRealTimers();
    }
  });

  it("releases startup replay claims if replay aborts before scheduling groups", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-replay-abort-release-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:446": {
              id: "42:446",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 446,
              text: "first replay claim must be released if later replay aborts",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
            "42:447": {
              id: "42:447",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 447,
              text: "second replay claim throws before groups schedule",
              status: "pending",
              attempts: 0,
              createdAt: 2,
              updatedAt: 2,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const originalClaim = ForegroundTextPromptQueue.prototype.claim;
    const claimSpy = vi
      .spyOn(ForegroundTextPromptQueue.prototype, "claim")
      .mockImplementation(function (this: ForegroundTextPromptQueue, id: string) {
        if (id === "42:447") {
          throw new Error("claim failed after first replay claim");
        }
        return originalClaim.call(this, id);
      });
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not run");
      callbacks.onAgentMessage?.("should not run");
      callbacks.onAgentEnd();
    });

    try {
      createBot(createConfig({ workspace } as any), createRegistry(session) as any);

      await vi.waitFor(async () => {
        const queue = JSON.parse(await readFile(path.join(queueDir, "foreground_text_prompts.json"), "utf8"));
        expect(queue.entries["42:446"]).toMatchObject({
          status: "pending",
          attempts: 1,
        });
        expect(queue.entries["42:446"].claimToken).toBeUndefined();
      });
      expect(session.prompt).not.toHaveBeenCalled();
    } finally {
      claimSpy.mockRestore();
    }
  });

  it("replays consecutive durable coalesced texts as one turn after a crash before the timer fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:434": {
              id: "42:434",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 434,
              text: "第一段 crash 前 coalescing",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-a",
              createdAt: 1_000,
              updatedAt: Date.now() - 31_000,
            },
            "42:435": {
              id: "42:435",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 435,
              text: "第二段 crash 前 coalescing",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-b",
              createdAt: 2_000,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("coalesced replay reply");
      callbacks.onAgentMessage?.("coalesced replay reply");
      callbacks.onAgentEnd();
    });

    createBot(createConfig({ workspace, telegramTextCoalesceMs: 60_000 } as any), createRegistry(session) as any);

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    const prompt = String(session.prompt.mock.calls[0][0]);
    expect(prompt).toContain("Albert sent these Telegram messages consecutively");
    expect(prompt).toContain("第一段 crash 前 coalescing");
    expect(prompt).toContain("第二段 crash 前 coalescing");
    expect(prompt.indexOf("第一段 crash 前 coalescing")).toBeLessThan(
      prompt.indexOf("第二段 crash 前 coalescing"),
    );
    await waitForForegroundQueueEmpty(workspace);
  });

  it("replays interleaved durable coalesced texts by sender bucket after a crash before the timer fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-replay-interleaved-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:437": {
              id: "42:437",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 437,
              text: "A 第一段 crash 前 coalescing",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-a1",
              createdAt: 1_000,
              updatedAt: Date.now() - 31_000,
            },
            "99:438": {
              id: "99:438",
              contextKey: "99",
              chatId: 99,
              fromId: 123,
              messageId: 438,
              text: "B context 插队消息",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-b",
              createdAt: 1_100,
              updatedAt: Date.now() - 31_000,
            },
            "42:439": {
              id: "42:439",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 439,
              text: "A 第二段 crash 前 coalescing",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-a2",
              createdAt: 1_200,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("replayed reply");
      callbacks.onAgentMessage?.("replayed reply");
      callbacks.onAgentEnd();
    });

    createBot(createConfig({ workspace, telegramTextCoalesceMs: 60_000 } as any), createRegistry(session) as any);

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    const prompts = session.prompt.mock.calls.map((call) => String(call[0]));
    const coalescedA = prompts.find((prompt) => prompt.includes("A 第一段 crash 前 coalescing"));
    expect(coalescedA).toBeTruthy();
    expect(coalescedA).toContain("A 第二段 crash 前 coalescing");
    expect(coalescedA).not.toContain("B context 插队消息");
    expect(prompts.find((prompt) => prompt.includes("B context 插队消息"))).toBeTruthy();
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not reorder same-context multi-sender durable replay while preserving cross-context coalescing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-replay-same-context-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:440": {
              id: "42:440",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 440,
              text: "A1 same context",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-a1",
              createdAt: 1_000,
              updatedAt: Date.now() - 31_000,
            },
            "42:441": {
              id: "42:441",
              contextKey: "42",
              chatId: 42,
              fromId: 456,
              messageId: 441,
              text: "B same context interleaves",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-b",
              createdAt: 1_100,
              updatedAt: Date.now() - 31_000,
            },
            "42:442": {
              id: "42:442",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 442,
              text: "A2 same context must stay after B",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old-a2",
              createdAt: 1_200,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("replayed reply");
      callbacks.onAgentMessage?.("replayed reply");
      callbacks.onAgentEnd();
    });

    createBot(
      createConfig({
        workspace,
        telegramAllowedUserIds: [123, 456],
        telegramAllowedUserIdSet: new Set([123, 456]),
        telegramTextCoalesceMs: 60_000,
      } as any),
      createRegistry(session) as any,
    );

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const prompts = session.prompt.mock.calls.map((call) => String(call[0]));
    expect(prompts[0]).toContain("A1 same context");
    expect(prompts[0]).not.toContain("A2 same context must stay after B");
    expect(prompts[1]).toContain("B same context interleaves");
    expect(prompts[2]).toContain("A2 same context must stay after B");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("claims startup durable text replay once across concurrent bot instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-cross-instance-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:404": {
              id: "42:404",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 404,
              text: "only one dispatcher instance may replay this",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const firstSession = createSession(async (callbacks) => {
      callbacks.onTextDelta("first reply");
      callbacks.onAgentMessage?.("first reply");
      callbacks.onAgentEnd();
    });
    const secondSession = createSession(async (callbacks) => {
      callbacks.onTextDelta("second reply");
      callbacks.onAgentMessage?.("second reply");
      callbacks.onAgentEnd();
    });

    createBot(createConfig({ workspace } as any), createRegistry(firstSession) as any);
    createBot(createConfig({ workspace } as any), createRegistry(secondSession) as any);

    await vi.waitFor(() => {
      expect(firstSession.prompt.mock.calls.length + secondSession.prompt.mock.calls.length).toBe(1);
    });
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not replay durable text prompts from users who are no longer authorized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-unauthorized-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:402": {
              id: "42:402",
              contextKey: "42",
              chatId: 42,
              fromId: 999,
              messageId: 402,
              text: "unauthorized replay must not reach Codex",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not run");
      callbacks.onAgentMessage?.("should not run");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    createBot(createConfig({ workspace } as any), registry as any);

    await delay(20);
    expect(session.prompt).not.toHaveBeenCalled();
    const queue = JSON.parse(await readFile(path.join(queueDir, "foreground_text_prompts.json"), "utf8"));
    expect(queue.entries).toEqual({});
  });

  it("does not submit a duplicate Codex turn when Telegram redelivers a durable message id during startup replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-duplicate-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:403": {
              id: "42:403",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 403,
              text: "redelivered durable message",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("reply");
      callbacks.onAgentMessage?.("reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 403, text: "redelivered durable message" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("redelivered durable message");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("persists live text before waiting for startup replay scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-live-before-replay-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:410": {
              id: "42:410",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 410,
              text: "startup replay is deliberately blocked",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayBlocked = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("reply");
      callbacks.onAgentMessage?.("reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await replayBlocked.promise;
      }
      return session;
    });

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const livePromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 411, text: "live text must be durable before replay finishes" },
      api: bot.api,
    });

    await vi.waitFor(async () => {
      const queue = JSON.parse(await readFile(path.join(queueDir, "foreground_text_prompts.json"), "utf8"));
      expect(queue.entries["42:411"]).toMatchObject({
        text: "live text must be durable before replay finishes",
        status: "processing",
      });
    });
    expect(session.prompt).not.toHaveBeenCalled();

    replayBlocked.resolve();
    await livePromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    await waitForForegroundQueueEmpty(workspace);
  });

  it("heartbeats live claims while waiting for startup replay scheduling", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-live-scheduling-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:444": {
              id: "42:444",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 444,
              text: "startup replay blocks live scheduling heartbeat",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayBlocked = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("reply");
      callbacks.onAgentMessage?.("reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await replayBlocked.promise;
      }
      return session;
    });

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const livePromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 445, text: "live claim must heartbeat before session lookup" },
      api: bot.api,
    });

    const queuePath = path.join(queueDir, "foreground_text_prompts.json");
    await vi.waitFor(async () => {
      const queue = JSON.parse(await readFile(queuePath, "utf8"));
      expect(queue.entries["42:445"]).toMatchObject({
        text: "live claim must heartbeat before session lookup",
        status: "processing",
      });
    });
    const claimedQueue = JSON.parse(await readFile(queuePath, "utf8"));
    claimedQueue.entries["42:445"].updatedAt = Date.now() - 31_000;
    await writeFile(queuePath, `${JSON.stringify(claimedQueue, null, 2)}\n`, "utf8");

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(async () => {
        const queue = JSON.parse(await readFile(queuePath, "utf8"));
        expect(queue.entries["42:445"].updatedAt).toBeGreaterThan(Date.now() - 30_000);
      }, { timeout: 100 });

      replayBlocked.resolve();
      await livePromise;
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
      await waitForForegroundQueueEmpty(workspace);
    } finally {
      replayBlocked.resolve();
      vi.useRealTimers();
    }
  });

  it("does not double-submit concurrent live redelivery of the same durable message id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-concurrent-redelivery-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const firstSessionLookupStarted = deferred<void>();
    const releaseFirstSessionLookup = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("reply");
      callbacks.onAgentMessage?.("reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        firstSessionLookupStarted.resolve();
        await releaseFirstSessionLookup.promise;
      }
      return session;
    });

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const first = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 422, text: "same update delivered concurrently" },
      api: bot.api,
    });
    await firstSessionLookupStarted.promise;

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 422, text: "same update delivered concurrently" },
      api: bot.api,
    });
    releaseFirstSessionLookup.resolve();
    await first;

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(String(session.prompt.mock.calls[0][0])).toContain("same update delivered concurrently");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("heartbeats an active durable text turn so another startup replay does not steal it", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-active-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const firstTurn = deferred<void>();
    const activeSession = createSession(async () => {
      await firstTurn.promise;
    });
    const activeRegistry = createRegistry(activeSession);

    const activeBot = createBot(createConfig({ workspace } as any), activeRegistry as any) as any;
    const textHandler = activeBot.__handlers.on.get("message:text");
    const activePrompt = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 428, text: "long active turn must stay owned" },
      api: activeBot.api,
    });
    await vi.waitFor(() => expect(activeSession.prompt).toHaveBeenCalledTimes(1));

    const queuePath = path.join(workspace, ".telecodex", "foreground_text_prompts.json");
    const claimedQueue = JSON.parse(await readFile(queuePath, "utf8"));
    claimedQueue.entries["42:428"].claimProcessId = 1;
    claimedQueue.entries["42:428"].updatedAt = Date.now() - 31_000;
    await writeFile(queuePath, `${JSON.stringify(claimedQueue, null, 2)}\n`, "utf8");

    await vi.advanceTimersByTimeAsync(10_000);
    const replaySession = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not replay");
      callbacks.onAgentMessage?.("should not replay");
      callbacks.onAgentEnd();
    });
    createBot(createConfig({ workspace } as any), createRegistry(replaySession) as any);
    await vi.advanceTimersByTimeAsync(20);

    try {
      expect(replaySession.prompt).not.toHaveBeenCalled();

      firstTurn.resolve();
      await activePrompt;
      await waitForForegroundQueueEmpty(workspace);
    } finally {
      firstTurn.resolve();
      await activePrompt;
      vi.useRealTimers();
    }
  });

  it("does not drop same-process redelivery of a durable text prompt left pending after timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-timeout-redelivery-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    let processing = false;
    let promptCalls = 0;
    const session = createSession(async (callbacks) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        processing = true;
        await new Promise(() => undefined);
        return;
      }
      callbacks.onTextDelta("retried reply");
      callbacks.onAgentMessage?.("retried reply");
      callbacks.onAgentEnd();
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockImplementation(async () => {
      processing = false;
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, codexTurnTimeoutMs: 5 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 412, text: "timeout redelivery must not be eaten" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 412, text: "timeout redelivery must not be eaten" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("timeout redelivery must not be eaten");
  });

  it("keeps /new behind startup durable replay scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-command-gate-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:413": {
              id: "42:413",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 413,
              text: "stale text must be scheduled before /new mutates the thread",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayBlocked = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("replayed");
      callbacks.onAgentMessage?.("replayed");
      callbacks.onAgentEnd();
    });
    (session as any).listWorkspaces = vi.fn(() => [workspace]);
    session.newThread.mockResolvedValue(session.getInfo());
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await replayBlocked.promise;
      }
      return session;
    });

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const newCommand = bot.__handlers.commands.get("new");
    const newPromise = newCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 414, text: "/new" },
      api: bot.api,
    });

    await delay(20);
    expect(session.newThread).not.toHaveBeenCalled();

    replayBlocked.resolve();
    await newPromise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not drop same-process redelivery after startup durable replay scheduling fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-replay-failure-redelivery-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:415": {
              id: "42:415",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 415,
              text: "redelivery after replay scheduling failure",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("retried after failed replay");
      callbacks.onAgentMessage?.("retried after failed replay");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockRejectedValueOnce(new Error("startup session unavailable")).mockResolvedValue(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 415, text: "redelivery after replay scheduling failure" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("redelivery after replay scheduling failure");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not eat live redelivery while startup durable replay is failing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-replay-failure-interleaving-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:423": {
              id: "42:423",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 423,
              text: "redelivery races with replay failure",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayLookupStarted = deferred<void>();
    const releaseReplayLookup = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("live retry reply");
      callbacks.onAgentMessage?.("live retry reply");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        replayLookupStarted.resolve();
        await releaseReplayLookup.promise;
        throw new Error("startup session unavailable");
      }
      return session;
    });

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    await replayLookupStarted.promise;
    const textHandler = bot.__handlers.on.get("message:text");
    const liveRedelivery = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 423, text: "redelivery races with replay failure" },
      api: bot.api,
    });

    await delay(20);
    expect(session.prompt).not.toHaveBeenCalled();

    releaseReplayLookup.resolve();
    await liveRedelivery;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("redelivery races with replay failure");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("keeps /logout replies behind startup durable replay scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-logout-gate-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:416": {
              id: "42:416",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 416,
              text: "stale text must be scheduled before logout mutates auth",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayBlocked = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("replayed before logout");
      callbacks.onAgentMessage?.("replayed before logout");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await replayBlocked.promise;
      }
      return session;
    });
    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const logoutCommand = bot.__handlers.commands.get("logout");
    const logoutPromise = logoutCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 417, text: "/logout" },
      api: bot.api,
    });

    await delay(20);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();

    replayBlocked.resolve();
    await logoutPromise;
    expect(bot.api.sendMessage).toHaveBeenCalled();
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await waitForForegroundQueueEmpty(workspace);
  });

  it("keeps /login replies behind startup durable replay scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-login-gate-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:418": {
              id: "42:418",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 418,
              text: "stale text must be scheduled before login mutates auth",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const replayBlocked = deferred<void>();
    let getOrCreateCalls = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("replayed before login");
      callbacks.onAgentMessage?.("replayed before login");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    registry.getOrCreate.mockImplementation(async () => {
      getOrCreateCalls += 1;
      if (getOrCreateCalls === 1) {
        await replayBlocked.promise;
      }
      return session;
    });
    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const loginCommand = bot.__handlers.commands.get("login");
    const loginPromise = loginCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 419, text: "/login" },
      api: bot.api,
    });

    await delay(20);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();

    replayBlocked.resolve();
    await loginPromise;
    expect(bot.api.sendMessage).toHaveBeenCalled();
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not drop durable queued text after registry removal in the same process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-remove-redelivery-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    let processing = false;
    let promptCalls = 0;
    const releaseFirstTurn = deferred<void>();
    const session = createSession(async (callbacks) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        processing = true;
        await releaseFirstTurn.promise;
        processing = false;
        callbacks.onTextDelta("first done");
        callbacks.onAgentMessage?.("first done");
        callbacks.onAgentEnd();
        return;
      }
      callbacks.onTextDelta("redelivered after remove");
      callbacks.onAgentMessage?.("redelivered after remove");
      callbacks.onAgentEnd();
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockImplementation(async () => {
      processing = false;
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 420, text: "active turn" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 421, text: "queued text survives registry removal" },
      api: bot.api,
    });
    registry.__removeCallbacks.forEach((callback: (key: string) => void) => callback("42"));
    releaseFirstTurn.resolve();
    await firstPromise;
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 421, text: "queued text survives registry removal" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("queued text survives registry removal");
    await waitForForegroundQueueEmpty(workspace);
  });

  it("waits for registry removal to mark durable queued text pending before live redelivery claims it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-remove-redelivery-race-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    let promptCalls = 0;
    const releaseFirstTurn = deferred<void>();
    const session = createSession(async (callbacks) => {
      promptCalls += 1;
      if (promptCalls === 1) {
        await releaseFirstTurn.promise;
        callbacks.onTextDelta("first done");
        callbacks.onAgentMessage?.("first done");
        callbacks.onAgentEnd();
        return;
      }
      callbacks.onTextDelta("redelivery after pending release");
      callbacks.onAgentMessage?.("redelivery after pending release");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 429, text: "active turn" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 430, text: "queued text waits for pending release" },
      api: bot.api,
    });

    const lockPath = path.join(workspace, ".telecodex", "foreground_text_prompts.json.lock");
    await writeFile(lockPath, "external-lock", "utf8");
    registry.__removeCallbacks.forEach((callback: (key: string) => void) => callback("42"));
    const redelivery = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 430, text: "queued text waits for pending release" },
      api: bot.api,
    });

    await delay(20);
    expect(session.prompt).toHaveBeenCalledTimes(1);

    await rm(lockPath, { force: true });
    await redelivery;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));

    releaseFirstTurn.resolve();
    await firstPromise;
    await waitForForegroundQueueEmpty(workspace);
  });

  it("does not delete durable coalesced text when a registry removal happens before the timer fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-coalesce-remove-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("should not run yet");
      callbacks.onAgentMessage?.("should not run yet");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace, telegramTextCoalesceMs: 60_000 } as any), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 424, text: "coalesced text must survive context removal" },
      api: bot.api,
    });

    registry.__removeCallbacks.forEach((callback: (key: string) => void) => callback("42"));

    await vi.waitFor(async () => {
      const queue = JSON.parse(
        await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
      );
      expect(queue.entries["42:424"]).toMatchObject({
        text: "coalesced text must survive context removal",
        status: "pending",
      });
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("preserves text arrival order when the first receipt reaction is slow", async () => {
    const firstReceiptReaction = deferred<void>();
    const firstTurn = deferred<void>();
    let reactionCalls = 0;
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

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    bot.api.setMessageReaction.mockImplementation(async () => {
      reactionCalls += 1;
      if (reactionCalls === 1) {
        await firstReceiptReaction.promise;
      }
      return true;
    });
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 60, text: "第一条，reaction 会慢" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(bot.api.setMessageReaction).toHaveBeenCalledTimes(1));

    const secondPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 61, text: "第二条，不能插队" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    expect(String(session.prompt.mock.calls[0][0])).toContain("第一条，reaction 会慢");

    firstReceiptReaction.resolve();
    firstTurn.resolve();
    await Promise.all([firstPromise, secondPromise]);

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条，不能插队");
  });

  it("does not let a stuck queued receipt reaction block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      if (promptCount === 1) {
        await firstTurn.promise;
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    bot.api.setMessageReaction.mockImplementation(async (_chatId: number, messageId: number, reactions: unknown[]) => {
      if (messageId === 63 && JSON.stringify(reactions).includes("👀")) {
        await new Promise(() => {});
      }
      return true;
    });
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 62, text: "第一条，先忙住" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 63, text: "第二条，receipt 永久卡住" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 64, text: "第三条，不能被第二条 reaction 卡住" },
      api: bot.api,
    });

    firstTurn.resolve();
    await expect(Promise.race([firstPromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条，receipt 永久卡住");
    expect(String(session.prompt.mock.calls[2][0])).toContain("第三条，不能被第二条 reaction 卡住");
  });

  it("does not let a stuck final reaction block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      if (promptCount === 1) {
        await firstTurn.promise;
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    bot.api.setMessageReaction.mockImplementation(async (_chatId: number, messageId: number, reactions: unknown[]) => {
      if (messageId === 67 && JSON.stringify(reactions).includes("👍")) {
        await new Promise(() => {});
      }
      return true;
    });
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 66, text: "第一条，先忙住" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 67, text: "第二条，final reaction 永久卡住" },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 68, text: "第三条，不能被第二条 final reaction 卡住" },
      api: bot.api,
    });

    firstTurn.resolve();
    await expect(Promise.race([firstPromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条，final reaction 永久卡住");
    expect(String(session.prompt.mock.calls[2][0])).toContain("第三条，不能被第二条 final reaction 卡住");
  });

  it("does not let a stuck clear reaction for a skipped queued prompt block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      if (promptCount === 1) {
        await firstTurn.promise;
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    bot.api.setMessageReaction.mockImplementation(async (_chatId: number, messageId: number, reactions: unknown[]) => {
      if (messageId === 71 && reactions.length === 0) {
        await new Promise(() => {});
      }
      return true;
    });
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/empty-clear-reaction.ogg",
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
          return { text: "   ", durationMs: 1 };
        }
      },
    }));
    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 70, text: "第一条，先忙住" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 71, voice: { file_id: "voice-file-empty-clear-reaction" } },
      api: bot.api,
    });
    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 72, text: "空语音 clear reaction 卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await expect(Promise.race([firstPromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("空语音 clear reaction 卡住后这条也必须进 Codex");
  });

  it("does not let a stuck retry reaction block retry prompt execution", async () => {
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    const textHandler = bot.__handlers.on.get("message:text");
    const retryCommand = bot.__handlers.commands.get("retry");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 84, text: "这条会被 retry" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    bot.api.setMessageReaction.mockImplementation(async (_chatId: number, messageId: number) => {
      if (messageId === 85) {
        await new Promise(() => {});
      }
      return true;
    });

    const retryPromise = retryCommand({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 85, text: "/retry" },
      api: bot.api,
    });

    await expect(Promise.race([retryPromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("这条会被 retry");
  });

  it("keeps the final reaction after a slow receipt reaction settles late", async () => {
    const slowReceiptReaction = deferred<void>();
    const finishTurn = deferred<void>();
    let callCount = 0;
    const session = createSession(async (callbacks) => {
      callbacks.onTextDelta("最终回复。");
      callbacks.onAgentMessage?.("最终回复。");
      await finishTurn.promise;
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ enableTelegramReactions: true }), registry as any) as any;
    bot.api.setMessageReaction.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        await slowReceiptReaction.promise;
      }
      return true;
    });
    const textHandler = bot.__handlers.on.get("message:text");

    const promptPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 65, text: "只跑一轮" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(bot.api.setMessageReaction).toHaveBeenCalledTimes(1));
    finishTurn.resolve();
    await promptPromise;

    expect(reactionEmojiFromCall(bot.api.setMessageReaction.mock.calls.at(-1))).toBe("👍");

    slowReceiptReaction.resolve();
    await vi.waitFor(() => expect(bot.api.setMessageReaction).toHaveBeenCalledTimes(3));
    expect(reactionEmojiFromCall(bot.api.setMessageReaction.mock.calls.at(-1))).toBe("👍");
  });

  it("transcribes and queues voice follow-ups that arrive while a Codex turn is still running", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("语音后续回复。");
        callbacks.onAgentMessage?.("语音后续回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/follow-up.ogg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );
    let transcribeCalls = 0;
    _setDecodeHook(async () => new Float32Array([0.1, 0.2]));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}

        async transcribe(): Promise<{ text: string; durationMs: number }> {
          transcribeCalls += 1;
          return {
            text: "这是忙时发来的语音转写",
            durationMs: 1,
          };
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 20, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 21, voice: { file_id: "voice-file-1" } },
      api: bot.api,
    });

    expect(bot.api.getFile).toHaveBeenCalledWith("voice-file-1");
    expect(transcribeCalls).toBe(1);

    firstTurn.resolve();
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("这是忙时发来的语音转写");
  });

  it("preserves Telegram arrival order when a voice transcription finishes after a later text arrives", async () => {
    const firstTurn = deferred<void>();
    const transcribeStarted = deferred<void>();
    const finishTranscription = deferred<{ text: string; durationMs: number }>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
        callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/follow-up.ogg",
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
          transcribeStarted.resolve();
          return await finishTranscription.promise;
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 30, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 31, voice: { file_id: "voice-file-2" } },
      api: bot.api,
    });

    await transcribeStarted.promise;

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 32, text: "语音后面发来的文字" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    finishTranscription.resolve({ text: "稍后完成的语音转写", durationMs: 1 });
    await voicePromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    expect(String(session.prompt.mock.calls[1][0])).toContain("稍后完成的语音转写");
    expect(String(session.prompt.mock.calls[2][0])).toContain("语音后面发来的文字");
  });

  it("queues photo follow-ups by Telegram arrival order while a Codex turn is running", async () => {
    const firstTurn = deferred<void>();
    const photoDownloadStarted = deferred<void>();
    const finishPhotoDownload = deferred<ArrayBuffer>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
        callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "photos/follow-up.jpg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        photoDownloadStarted.resolve();
        return {
          ok: true,
          arrayBuffer: async () => finishPhotoDownload.promise,
        };
      }),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const photoHandler = bot.__handlers.on.get("message:photo");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 49, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const photoPromise = photoHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 50,
        photo: [{ file_id: "photo-file-queued" }],
        caption: "先看这张图",
      },
      api: bot.api,
    });
    await expect(
      Promise.race([photoDownloadStarted.promise.then(() => "started"), delay(50).then(() => "not-started")]),
    ).resolves.toBe("started");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 51, text: "图片后面发来的文字" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    finishPhotoDownload.resolve(new Uint8Array([1, 2, 3]).buffer);
    await photoPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const photoInput = session.prompt.mock.calls[1][0] as { imagePaths?: string[]; text?: string };
    expect(photoInput.imagePaths).toHaveLength(1);
    expect(photoInput.text).toContain("先看这张图");
    expect(String(session.prompt.mock.calls[2][0])).toContain("图片后面发来的文字");
  });

  it("does not let a stuck photo download failure notice block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "photos/fail.jpg",
      file_size: 3,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Failed to download photo")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("photo download failed");
      }),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const photoHandler = bot.__handlers.on.get("message:photo");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 76, text: "先跑一个长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const photoPromise = photoHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 77,
        photo: [{ file_id: "photo-file-fail-stuck-notice" }],
      },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 78, text: "图片下载失败通知卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(Promise.race([photoPromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("图片下载失败通知卡住后这条也必须进 Codex");
  });

  it("queues document follow-ups by Telegram arrival order while a Codex turn is running", async () => {
    const firstTurn = deferred<void>();
    const documentDownloadStarted = deferred<void>();
    const finishDocumentDownload = deferred<ArrayBuffer>();
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-queue-"));
    tempDirs.push(workspace);
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
        callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/follow-up.txt",
      file_size: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        documentDownloadStarted.resolve();
        return {
          ok: true,
          arrayBuffer: async () => finishDocumentDownload.promise,
        };
      }),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const documentHandler = bot.__handlers.on.get("message:document");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 52, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 53,
        document: { file_id: "doc-file-queued", file_name: "report.txt", mime_type: "text/plain", file_size: 5 },
        caption: "先总结这个文档",
      },
      api: bot.api,
    });
    await expect(
      Promise.race([documentDownloadStarted.promise.then(() => "started"), delay(50).then(() => "not-started")]),
    ).resolves.toBe("started");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 54, text: "文档后面发来的文字" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    finishDocumentDownload.resolve(new TextEncoder().encode("hello").buffer);
    await documentPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const documentInput = session.prompt.mock.calls[1][0] as { stagedFileInstructions?: string; text?: string };
    expect(documentInput.stagedFileInstructions).toContain("report.txt");
    expect(documentInput.text).toContain("先总结这个文档");
    expect(documentInput.text).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(documentInput.text?.startsWith("先总结这个文档\n\n[CODEX EXEC ADAPTER OVERRIDE]")).toBe(true);
    expect(String(session.prompt.mock.calls[2][0])).toContain("文档后面发来的文字");
  });

  it("does not let a stuck document download failure notice block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/fail.txt",
      file_size: 5,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Failed to download file")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("document download failed");
      }),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const documentHandler = bot.__handlers.on.get("message:document");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 79, text: "先跑一个长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 80,
        document: { file_id: "doc-file-download-fail-stuck-notice", file_name: "report.txt", file_size: 5 },
      },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 81, text: "文档下载失败通知卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(
      Promise.race([documentPromise.then(() => "resolved"), delay(50).then(() => "timed-out")]),
    ).resolves.toBe("resolved");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("文档下载失败通知卡住后这条也必须进 Codex");
  });

  it("queues a document prompt even when the received acknowledgement fails to send", async () => {
    const firstTurn = deferred<void>();
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-ack-fail-"));
    tempDirs.push(workspace);
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
        callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/ack-fail.txt",
      file_size: 5,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Received:")) {
        throw new Error("document acknowledgement failed");
      }
      messageId += 1;
      return { message_id: messageId };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const documentHandler = bot.__handlers.on.get("message:document");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 58, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 59,
        document: { file_id: "doc-file-ack-fail", file_name: "report.txt", mime_type: "text/plain", file_size: 5 },
        caption: "先总结这个文档",
      },
      api: bot.api,
    });

    await expect(
      Promise.race([
        documentPromise.then(
          () => "resolved",
          () => "rejected",
        ),
        delay(50).then(() => "timed-out"),
      ]),
    ).resolves.toBe("resolved");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 60, text: "文档确认失败后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const documentInput = session.prompt.mock.calls[1][0] as { stagedFileInstructions?: string; text?: string };
    expect(documentInput.stagedFileInstructions).toContain("report.txt");
    expect(documentInput.text).toContain("先总结这个文档");
    expect(documentInput.text).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(documentInput.text?.startsWith("先总结这个文档\n\n[CODEX EXEC ADAPTER OVERRIDE]")).toBe(true);
    expect(String(session.prompt.mock.calls[2][0])).toContain("文档确认失败后这条也必须进 Codex");
  });

  it("does not let a stuck document acknowledgement block the queue", async () => {
    const firstTurn = deferred<void>();
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-ack-stuck-"));
    tempDirs.push(workspace);
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta(`第 ${promptCount} 轮回复。`);
        callbacks.onAgentMessage?.(`第 ${promptCount} 轮回复。`);
      }
      callbacks.onAgentEnd();
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/ack-stuck.txt",
      file_size: 5,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Received:")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const documentHandler = bot.__handlers.on.get("message:document");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 67, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 68,
        document: { file_id: "doc-file-ack-stuck", file_name: "report.txt", mime_type: "text/plain", file_size: 5 },
        caption: "先总结这个文档",
      },
      api: bot.api,
    });

    await expect(
      Promise.race([documentPromise.then(() => "resolved"), delay(50).then(() => "timed-out")]),
    ).resolves.toBe("resolved");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 69, text: "文档确认卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(3));
    const documentInput = session.prompt.mock.calls[1][0] as { stagedFileInstructions?: string; text?: string };
    expect(documentInput.stagedFileInstructions).toContain("report.txt");
    expect(documentInput.text).toContain("先总结这个文档");
    expect(documentInput.text).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(documentInput.text?.startsWith("先总结这个文档\n\n[CODEX EXEC ADAPTER OVERRIDE]")).toBe(true);
    expect(String(session.prompt.mock.calls[2][0])).toContain("文档确认卡住后这条也必须进 Codex");
  });

  it("does not let a stuck document stage failure notice pin the document handler", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-stage-notice-stuck-"));
    tempDirs.push(workspace);
    let messageId = 0;
    const session = createSession(async () => {
      throw new Error("document stage failure should not reach Codex");
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/stage-fail.txt",
      file_size: 5,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Failed to stage file")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
    });
    await mkdir(path.join(workspace, ".telecodex"), { recursive: true });
    await writeFile(path.join(workspace, ".telecodex", "inbox"), "not a directory");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );

    const documentHandler = bot.__handlers.on.get("message:document");
    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 82,
        document: { file_id: "doc-file-stage-fail-stuck-notice", file_name: "report.txt", file_size: 5 },
      },
      api: bot.api,
    });

    await expect(
      Promise.race([documentPromise.then(() => "resolved"), delay(50).then(() => "timed-out")]),
    ).resolves.toBe("resolved");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("does not let a stuck document outbox failure notice pin the document handler", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-outbox-notice-stuck-"));
    tempDirs.push(workspace);
    let messageId = 0;
    const session = createSession(async () => {
      throw new Error("document outbox failure should not reach Codex");
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/outbox-notice-stuck.txt",
      file_size: 5,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Failed to prepare output folder")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
    });
    await mkdir(path.join(workspace, ".telecodex"), { recursive: true });
    await writeFile(path.join(workspace, ".telecodex", "turns"), "not a directory");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );

    const documentHandler = bot.__handlers.on.get("message:document");
    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 83,
        document: { file_id: "doc-file-outbox-fail-stuck-notice", file_name: "report.txt", file_size: 5 },
      },
      api: bot.api,
    });

    await expect(
      Promise.race([documentPromise.then(() => "resolved"), delay(50).then(() => "timed-out")]),
    ).resolves.toBe("resolved");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("drains later queued text after document outbox preparation fails", async () => {
    const firstTurn = deferred<void>();
    const workspace = await mkdtemp(path.join(tmpdir(), "telecodex-doc-outbox-fail-"));
    tempDirs.push(workspace);
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    session.getCurrentWorkspace.mockReturnValue(workspace);
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      workspace,
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig({ workspace }), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "documents/outbox-fail.txt",
      file_size: 5,
    });
    await mkdir(path.join(workspace, ".telecodex"), { recursive: true });
    await writeFile(path.join(workspace, ".telecodex", "turns"), "not a directory");
    bot.api.sendMessage.mockImplementation(async () => {
      messageId += 1;
      return { message_id: messageId };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      })),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const documentHandler = bot.__handlers.on.get("message:document");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 61, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const documentPromise = documentHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: {
        message_id: 62,
        document: { file_id: "doc-file-outbox-fail", file_name: "report.txt", mime_type: "text/plain", file_size: 5 },
      },
      api: bot.api,
    });

    await expect(
      Promise.race([
        documentPromise.then(
          () => "resolved",
          () => "rejected",
        ),
        delay(50).then(() => "timed-out"),
      ]),
    ).resolves.toBe("resolved");

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 63, text: "文档 outbox 失败后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("文档 outbox 失败后这条也必须进 Codex");
  });

  it("drains later queued text after an earlier voice transcription fails", async () => {
    const firstTurn = deferred<void>();
    const transcribeStarted = deferred<void>();
    const failTranscription = deferred<{ text: string; durationMs: number }>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/fail.ogg",
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
          transcribeStarted.resolve();
          return await failTranscription.promise;
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 40, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 41, voice: { file_id: "voice-file-fail" } },
      api: bot.api,
    });
    await transcribeStarted.promise;

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 42, text: "语音失败后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    failTranscription.reject(new Error("transcription failed"));
    await voicePromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("语音失败后这条也必须进 Codex");
  });

  it("does not let a stuck voice transcription failure notice block later queued prompts", async () => {
    const firstTurn = deferred<void>();
    const transcribeStarted = deferred<void>();
    const failTranscription = deferred<{ text: string; durationMs: number }>();
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/fail-stuck-notice.ogg",
      file_size: 3,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Transcription failed")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
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
          transcribeStarted.resolve();
          return await failTranscription.promise;
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 73, text: "先跑一个长任务" },
      api: bot.api,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 74, voice: { file_id: "voice-file-fail-stuck-notice" } },
      api: bot.api,
    });
    await transcribeStarted.promise;

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 75, text: "语音失败通知卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    failTranscription.reject(new Error("transcription failed"));
    await expect(Promise.race([voicePromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("语音失败通知卡住后这条也必须进 Codex");
  });

  it("drains later queued text after an empty voice transcript notice fails to send", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/empty.ogg",
      file_size: 3,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Transcription was empty")) {
        throw new Error("empty notice send failed");
      }
      messageId += 1;
      return { message_id: messageId };
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
          return { text: "   ", durationMs: 1 };
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 64, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 65, voice: { file_id: "voice-file-empty" } },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 66, text: "空语音后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;
    await voicePromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("空语音后这条也必须进 Codex");
    const replies = bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n");
    expect(replies).not.toContain("Transcription failed");
  });

  it("drains later queued text after an empty voice transcript notice never settles", async () => {
    const firstTurn = deferred<void>();
    let promptCount = 0;
    let messageId = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/empty-stuck-notice.ogg",
      file_size: 3,
    });
    bot.api.sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (String(text).includes("Transcription was empty")) {
        return await new Promise(() => {});
      }
      messageId += 1;
      return { message_id: messageId };
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
          return { text: "   ", durationMs: 1 };
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 70, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 71, voice: { file_id: "voice-file-empty-stuck-notice" } },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 72, text: "空语音通知卡住后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(Promise.race([voicePromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("空语音通知卡住后这条也必须进 Codex");
  });

  it("drains later queued text after a stuck voice download times out", async () => {
    process.env.TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = "5";
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/stuck.ogg",
      file_size: 3,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("download aborted")));
        });
      }),
    );

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 43, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 44, voice: { file_id: "voice-file-stuck" } },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 45, text: "语音下载超时后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(Promise.race([voicePromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("语音下载超时后这条也必须进 Codex");
  });

  it("drains later queued text after a stuck voice transcription times out", async () => {
    process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS = "5";
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn().mockResolvedValue({
      file_path: "voice/stuck-transcription.ogg",
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
          return await new Promise(() => {});
        }
      },
    }));

    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 146, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 147, voice: { file_id: "voice-file-stuck-transcription" } },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 148, text: "语音转写超时后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(Promise.race([voicePromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("语音转写超时后这条也必须进 Codex");
  });

  it("drains later queued text after a stuck Telegram getFile times out", async () => {
    process.env.TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = "5";
    const firstTurn = deferred<void>();
    let promptCount = 0;
    const session = createSession(async (callbacks) => {
      promptCount += 1;
      if (promptCount === 1) {
        callbacks.onTextDelta("第一轮回复。");
        callbacks.onAgentMessage?.("第一轮回复。");
        await firstTurn.promise;
      } else {
        callbacks.onTextDelta("后续文本回复。");
        callbacks.onAgentMessage?.("后续文本回复。");
      }
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const bot = createBot(createConfig(), registry as any) as any;
    bot.api.getFile = vi.fn(() => new Promise(() => {}));
    const textHandler = bot.__handlers.on.get("message:text");
    const voiceHandler = bot.__handlers.on.get("message:voice|message:audio");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 46, text: "先跑一个长任务" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    const voicePromise = voiceHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 47, voice: { file_id: "voice-file-getfile-stuck" } },
      api: bot.api,
    });

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 48, text: "getFile 超时后这条也必须进 Codex" },
      api: bot.api,
    });

    firstTurn.resolve();
    await firstPromise;

    await expect(Promise.race([voicePromise.then(() => "resolved"), delay(50).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("getFile 超时后这条也必须进 Codex");
  });

  it("waits for the final Telegram reply before draining the next queued prompt", async () => {
    const firstTurn = deferred<void>();
    const firstSend = deferred<{ message_id: number }>();
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
    let sendCount = 0;
    bot.api.sendMessage.mockImplementation(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return await firstSend.promise;
      }
      return { message_id: sendCount };
    });
    const textHandler = bot.__handlers.on.get("message:text");

    const firstPromise = textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 50, text: "第一条，回复发送要慢一点" },
      api: bot.api,
    });

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    await textHandler({
      chat: { id: 42 },
      from: { id: 123 },
      message: { message_id: 51, text: "第二条必须等第一条真正发完" },
      api: bot.api,
    });

    firstTurn.resolve();
    await delay(20);
    expect(session.prompt).toHaveBeenCalledTimes(1);

    firstSend.resolve({ message_id: 101 });
    await firstPromise;

    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条必须等第一条真正发完");
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

async function readForegroundQueueEntries(workspace: string): Promise<Record<string, unknown>> {
  try {
    const queue = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    return queue.entries ?? {};
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function waitForForegroundQueueEmpty(workspace: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await readForegroundQueueEntries(workspace)).toEqual({});
  });
}

function reactionEmojiFromCall(call: unknown[] | undefined): string | undefined {
  const reactions = call?.[2] as Array<{ emoji?: string }> | undefined;
  return reactions?.[0]?.emoji;
}
