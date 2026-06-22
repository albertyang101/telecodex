import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
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
    getCurrentWorkspace: vi.fn(() => "/workspace/base"),
    prompt: vi.fn(async (input, callbacks: CodexSessionCallbacks) => {
      await onPrompt(callbacks, input);
    }),
    abort: vi.fn(async () => undefined),
    getInfo: vi.fn(() => ({
      threadId: "thread-1",
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
  });

  const createRegistry = (session: any) => ({
    onRemove: vi.fn(),
    get: vi.fn(() => session),
    getOrCreate: vi.fn(async () => session),
    updateMetadata: vi.fn(),
  });

  beforeEach(() => {
    mockGrammy.bots.length = 0;
    mockGrammy.Bot.mockClear();
    mockAuth.checkAuthStatus.mockClear();
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
    expect(codexInput).toContain("explain why a bug happened before fixing it");
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
    expect(input.text).toBe("帮我总结");
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

  it("aborts a stuck foreground Codex turn after the configured timeout and drains queued prompts", async () => {
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

    const bot = createBot(createConfig({ codexTurnTimeoutMs: 5 } as any), registry as any) as any;
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

    await expect(Promise.race([firstPromise.then(() => "resolved"), delay(100).then(() => "timed-out")])).resolves.toBe(
      "resolved",
    );

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    releaseAbortedTurn.resolve();
    await abortedTurnSettled.promise;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
    expect(String(session.prompt.mock.calls[1][0])).toContain("第二条必须在超时后继续进 Codex");
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).toContain(
      "Request timed out. Try a shorter prompt or use /retry.",
    );
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
    expect(documentInput.text).toBe("先总结这个文档");
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
    expect(documentInput.text).toBe("先总结这个文档");
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
    expect(documentInput.text).toBe("先总结这个文档");
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

function reactionEmojiFromCall(call: unknown[] | undefined): string | undefined {
  const reactions = call?.[2] as Array<{ emoji?: string }> | undefined;
  return reactions?.[0]?.emoji;
}
