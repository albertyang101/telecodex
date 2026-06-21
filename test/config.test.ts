import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_PATH;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    delete process.env.CODEX_SANDBOX_MODE;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_LAUNCH_PROFILES_JSON;
    delete process.env.CODEX_DEFAULT_LAUNCH_PROFILE;
    delete process.env.ENABLE_UNSAFE_LAUNCH_PROFILES;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.STREAM_AGENT_RESPONSES;
    delete process.env.SHOW_TURN_TOKEN_USAGE;
    delete process.env.MAX_FILE_SIZE;
    delete process.env.ENABLE_TELEGRAM_LOGIN;
    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    delete process.env.MAILBOX_ENABLED;
    delete process.env.MAILBOX_PERSONA;
    delete process.env.PERSONAS_ROOT;
    delete process.env.CLAUDE_PERSONAS_ROOT;
    delete process.env.MAILBOX_CONTEXT_KEY;
    delete process.env.MAILBOX_POLL_MS;
    delete process.env.MAILBOX_FULL_SCAN_MS;
    delete process.env.MAILBOX_AUTO_REPLY;
    delete process.env.MAILBOX_MAX_MESSAGES_PER_TICK;
    delete process.env.MAILBOX_MIN_SENT_AT;
    delete process.env.TELEGRAM_TRANSPORT_MCP_ENABLED;
    delete process.env.TELEGRAM_TRANSPORT_MCP_SERVER_NAME;
    delete process.env.TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH;
    delete process.env.TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES;
    delete process.env.TELEGRAM_TRANSPORT_MCP_STARTUP_TIMEOUT_MS;
    delete process.env.TELEGRAM_TRANSPORT_MCP_TOOL_TIMEOUT_MS;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: TELEGRAM_ALLOWED_USER_IDS",
    );
  });

  it("parses a valid config correctly", () => {
    const codexPath = path.join(tempDir, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    chmodSync(codexPath, 0o755);

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_PATH = codexPath;
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_REASONING_EFFORT = "xhigh";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      workspace: process.cwd(),
      maxFileSize: 20 * 1024 * 1024,
      codexApiKey: "secret-key",
      codexPathOverride: codexPath,
      codexModel: "o3",
      codexReasoningEffort: "xhigh",
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "on-request",
      launchProfiles: [
        {
          id: "default",
          label: "Default",
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          unsafe: true,
        },
        {
          id: "readonly",
          label: "Read Only",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          unsafe: false,
        },
        {
          id: "review",
          label: "Review",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          unsafe: false,
        },
      ],
      defaultLaunchProfileId: "default",
      enableUnsafeLaunchProfiles: false,
      toolVerbosity: "all",
      streamAgentResponses: true,
      showTurnTokenUsage: false,
      enableTelegramLogin: true,
      enableTelegramReactions: false,
      mailboxBridge: {
        enabled: false,
        persona: undefined,
        personasRoot: path.join(homedir(), "personas"),
        contextKey: undefined,
        pollMs: 500,
        fullScanMs: 10_000,
        autoReply: false,
        maxMessagesPerTick: 1,
        minSentAt: undefined,
      },
      telegramTransport: {
        enabled: false,
        mcpServerName: "telegram_transport",
        personasStatePath: path.join(homedir(), "code", "claude", "state", "personas.json"),
        blockedPersonaPrefixes: ["dadamia_"],
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 30_000,
      },
    });
  });

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.codexApiKey).toBeUndefined();
    expect(config.codexPathOverride).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
    expect(config.codexReasoningEffort).toBeUndefined();
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(config.defaultLaunchProfileId).toBe("default");
    expect(config.enableUnsafeLaunchProfiles).toBe(false);
    expect(config.toolVerbosity).toBe("none");
    expect(config.streamAgentResponses).toBe(true);
    expect(config.showTurnTokenUsage).toBe(false);
    expect(config.enableTelegramLogin).toBe(true);
    expect(config.enableTelegramReactions).toBe(false);
    expect(config.workspace).toBe(process.cwd());
  });

  it("throws when CODEX_PATH is relative", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_PATH = "codex";

    expect(() => loadConfig()).toThrow("CODEX_PATH must be an absolute path");
  });

  it("throws when CODEX_PATH does not exist", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_PATH = path.join(tempDir, "missing-codex");

    expect(() => loadConfig()).toThrow("CODEX_PATH does not exist");
  });

  it("throws when CODEX_PATH is not executable", () => {
    const codexPath = path.join(tempDir, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    chmodSync(codexPath, 0o644);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_PATH = codexPath;

    expect(() => loadConfig()).toThrow("CODEX_PATH is not executable");
  });

  it("throws when a user id is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "CODEX_API_KEY='from-dotenv'",
        'CODEX_MODEL="gpt-4.1"',
        "CODEX_SANDBOX_MODE=read-only",
        "CODEX_APPROVAL_POLICY=on-failure",
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.codexApiKey).toBe("from-dotenv");
    expect(config.codexModel).toBe("gpt-4.1");
    expect(config.codexSandboxMode).toBe("read-only");
    expect(config.codexApprovalPolicy).toBe("on-failure");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "read-only",
        approvalPolicy: "on-failure",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("resolves workspace to /workspace when running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses ENABLE_TELEGRAM_LOGIN boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_LOGIN;
    const config = loadConfig();
    expect(config.enableTelegramLogin).toBe(true);
  });

  it("parses ENABLE_TELEGRAM_REACTIONS boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    const config = loadConfig();
    expect(config.enableTelegramReactions).toBe(false);
  });

  it("parses SHOW_TURN_TOKEN_USAGE boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(false);
    }

    delete process.env.SHOW_TURN_TOKEN_USAGE;
    const config = loadConfig();
    expect(config.showTurnTokenUsage).toBe(false);
  });

  it("enables the mailbox bridge when MAILBOX_PERSONA is configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "read-only";
    process.env.MAILBOX_PERSONA = "albert-v3";
    process.env.PERSONAS_ROOT = "/Users/albert/personas";
    process.env.MAILBOX_CONTEXT_KEY = "mailbox:theo";
    process.env.MAILBOX_POLL_MS = "750";
    process.env.MAILBOX_FULL_SCAN_MS = "30000";
    process.env.MAILBOX_AUTO_REPLY = "true";
    process.env.MAILBOX_MAX_MESSAGES_PER_TICK = "2";
    process.env.MAILBOX_MIN_SENT_AT = "2026-06-21T06:15:00Z";

    const config = loadConfig();

    expect(config.mailboxBridge).toEqual({
      enabled: true,
      persona: "albert-v3",
      personasRoot: "/Users/albert/personas",
      contextKey: "mailbox:theo",
      pollMs: 750,
      fullScanMs: 30_000,
      autoReply: true,
      maxMessagesPerTick: 2,
      minSentAt: "2026-06-21T06:15:00Z",
    });
  });

  it("enables direct Telegram transport MCP only when explicitly configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_TRANSPORT_MCP_ENABLED = "true";
    process.env.TELEGRAM_TRANSPORT_MCP_SERVER_NAME = "telegram_transport";
    process.env.TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH = "/Users/albert/code/claude/state/personas.json";
    process.env.TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES = "dadamia_,paperclip_";
    process.env.TELEGRAM_TRANSPORT_MCP_STARTUP_TIMEOUT_MS = "15000";
    process.env.TELEGRAM_TRANSPORT_MCP_TOOL_TIMEOUT_MS = "45000";

    const config = loadConfig();

    expect(config.telegramTransport).toEqual({
      enabled: true,
      mcpServerName: "telegram_transport",
      personasStatePath: "/Users/albert/code/claude/state/personas.json",
      blockedPersonaPrefixes: ["dadamia_", "paperclip_"],
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 45_000,
    });
  });

  it("rejects unsafe direct Telegram transport MCP server names", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_TRANSPORT_MCP_ENABLED = "true";
    process.env.TELEGRAM_TRANSPORT_MCP_SERVER_NAME = "../telegram";

    expect(() => loadConfig()).toThrow("TELEGRAM_TRANSPORT_MCP_SERVER_NAME must be a safe MCP server name");
  });

  it("rejects mailbox bridge startup unless the default Codex launch is read-only and never approval", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MAILBOX_PERSONA = "albert-v3";
    process.env.CODEX_SANDBOX_MODE = "workspace-write";
    process.env.CODEX_APPROVAL_POLICY = "never";

    expect(() => loadConfig()).toThrow(
      "MAILBOX_PERSONA requires the default Codex launch profile to be read-only / never",
    );
  });

  it("rejects invalid MAILBOX_MIN_SENT_AT values instead of disabling the cutoff", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "read-only";
    process.env.CODEX_APPROVAL_POLICY = "never";
    process.env.MAILBOX_PERSONA = "albert-v3";
    process.env.MAILBOX_MIN_SENT_AT = "not-a-date";

    expect(() => loadConfig()).toThrow("MAILBOX_MIN_SENT_AT must be an ISO or compact UTC timestamp");
  });

  it("parses STREAM_AGENT_RESPONSES boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.STREAM_AGENT_RESPONSES = value;
      const config = loadConfig();
      expect(config.streamAgentResponses).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.STREAM_AGENT_RESPONSES = value;
      const config = loadConfig();
      expect(config.streamAgentResponses).toBe(false);
    }

    delete process.env.STREAM_AGENT_RESPONSES;
    const config = loadConfig();
    expect(config.streamAgentResponses).toBe(true);
  });

  it("falls back to defaults for invalid optional enum values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "unsafe";
    process.env.CODEX_APPROVAL_POLICY = "sometimes";
    process.env.TOOL_VERBOSITY = "loud";
    process.env.MAX_FILE_SIZE = "nope";

    const config = loadConfig();

    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("none");
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it("parses explicit launch profiles and default selection", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.ENABLE_UNSAFE_LAUNCH_PROFILES = "true";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "readonly";

    const config = loadConfig();

    expect(config.enableUnsafeLaunchProfiles).toBe(true);
    expect(config.defaultLaunchProfileId).toBe("readonly");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
      {
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
    ]);
  });

  it("throws when CODEX_DEFAULT_LAUNCH_PROFILE is unknown", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "missing";

    expect(() => loadConfig()).toThrow("Unknown CODEX_DEFAULT_LAUNCH_PROFILE: missing");
  });

  it("throws when CODEX_REASONING_EFFORT is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_REASONING_EFFORT = "maximum";

    expect(() => loadConfig()).toThrow(
      "Invalid CODEX_REASONING_EFFORT: maximum. Expected one of minimal, low, medium, high, xhigh",
    );
  });

  it("throws when unsafe extra launch profiles are configured without enabling them", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);

    expect(() => loadConfig()).toThrow(
      'Unsafe launch profile "danger-full" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true',
    );
  });

  it("throws on duplicate launch profile ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "readonly",
        label: "Read Only 2",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      },
    ]);

    expect(() => loadConfig()).toThrow("Duplicate launch profile id: readonly");
  });
});
