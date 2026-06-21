import { vi } from "vitest";

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

describe("createBot response delivery", () => {
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

  const createSession = (onPrompt: (callbacks: CodexSessionCallbacks) => Promise<void>) => ({
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    newThread: vi.fn(),
    prompt: vi.fn(async (_input, callbacks: CodexSessionCallbacks) => {
      await onPrompt(callbacks);
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
});
