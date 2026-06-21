import { mkdtemp, rm } from "node:fs/promises";
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
    getInfo: vi.fn(() => ({
      threadId: "thread-1",
      workspace: "/workspace/base",
      model: "gpt-5.5",
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

    expect(String(session.prompt.mock.calls[0][0])).toContain("这段转写只应该进 Codex");
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
    expect(input.stagedFileInstructions).toContain("staged on disk");
    expect(input.text).toBe("帮我总结");
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
    expect(bot.api.sendMessage.mock.calls.map((call: unknown[]) => String(call[1])).join("\n")).not.toContain(
      "Still working on previous message",
    );
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
