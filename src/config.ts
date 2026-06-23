import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface MailboxBridgeConfig {
  enabled: boolean;
  persona?: string;
  personasRoot: string;
  contextKey?: string;
  pollMs: number;
  fullScanMs: number;
  autoReply: boolean;
  maxMessagesPerTick: number;
  minSentAt?: string;
  promptTimeoutMs?: number;
}

export interface TelegramTransportConfig {
  enabled: boolean;
  mcpServerName: string;
  personasStatePath: string;
  blockedPersonaPrefixes: string[];
  autoApproveSends: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface LinearControlConfig {
  enabled: boolean;
  mcpServerName: string;
  allowedIssues: string[];
  apiKeyPath: string;
  autoApproveEvidence: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  workspace: string;
  maxFileSize: number;
  codexApiKey?: string;
  codexPathOverride?: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexTurnTimeoutMs?: number;
  codexTurnAbortGraceMs?: number;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  streamAgentResponses: boolean;
  showTurnTokenUsage: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  memoryTranscriptRoot?: string;
  mailboxBridge: MailboxBridgeConfig;
  telegramTransport: TelegramTransportConfig;
  linearControl: LinearControlConfig;
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const workspace = resolveWorkspace();
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexPathOverride = parseCodexPathOverride(optionalString(process.env.CODEX_PATH));
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexReasoningEffort = parseReasoningEffort(optionalString(process.env.CODEX_REASONING_EFFORT));
  const codexTurnTimeoutMs = parseOptionalPositiveIntegerEnv(
    optionalString(process.env.CODEX_TURN_TIMEOUT_MS),
    "CODEX_TURN_TIMEOUT_MS",
  );
  const codexTurnAbortGraceMs = parseOptionalPositiveIntegerEnv(
    optionalString(process.env.CODEX_TURN_ABORT_GRACE_MS),
    "CODEX_TURN_ABORT_GRACE_MS",
  );
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const streamAgentResponses = parseBooleanEnv(optionalString(process.env.STREAM_AGENT_RESPONSES), true);
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), true);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const memoryTranscriptRoot = parseOptionalAbsolutePath(
    optionalString(process.env.TRANSCRIPT_ROOT),
    "TRANSCRIPT_ROOT",
  );
  const mailboxBridge = parseMailboxBridgeConfig();
  const telegramTransport = parseTelegramTransportConfig();
  const linearControl = parseLinearControlConfig();
  validateMcpServerNames(telegramTransport, linearControl);
  validateMailboxBridgeLaunch(mailboxBridge, launchProfiles, defaultLaunchProfileId);

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    workspace,
    maxFileSize,
    codexApiKey,
    codexPathOverride,
    codexModel,
    codexReasoningEffort,
    codexTurnTimeoutMs,
    codexTurnAbortGraceMs,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    streamAgentResponses,
    showTurnTokenUsage,
    enableTelegramLogin,
    enableTelegramReactions,
    memoryTranscriptRoot,
    mailboxBridge,
    telegramTransport,
    linearControl,
  };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCodexPathOverride(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  if (!path.isAbsolute(raw)) {
    throw new Error("CODEX_PATH must be an absolute path");
  }

  if (!existsSync(raw)) {
    throw new Error(`CODEX_PATH does not exist: ${raw}`);
  }

  try {
    accessSync(raw, constants.X_OK);
  } catch {
    throw new Error(`CODEX_PATH is not executable: ${raw}`);
  }

  return raw;
}

function parseOptionalAbsolutePath(raw: string | undefined, name: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  if (!path.isAbsolute(raw)) {
    throw new Error(`${name} must be an absolute path`);
  }

  return raw;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parsePositiveIntegerEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parseMailboxBridgeConfig(): MailboxBridgeConfig {
  const persona = optionalString(process.env.MAILBOX_PERSONA);
  const enabled = Boolean(persona) && parseBooleanEnv(optionalString(process.env.MAILBOX_ENABLED), true);
  const personasRoot =
    optionalString(process.env.PERSONAS_ROOT) ??
    optionalString(process.env.CLAUDE_PERSONAS_ROOT) ??
    path.join(homedir(), "personas");

  return {
    enabled,
    persona,
    personasRoot,
    contextKey: optionalString(process.env.MAILBOX_CONTEXT_KEY),
    pollMs: parsePositiveIntegerEnv(optionalString(process.env.MAILBOX_POLL_MS), 500, "MAILBOX_POLL_MS"),
    fullScanMs: parsePositiveIntegerEnv(
      optionalString(process.env.MAILBOX_FULL_SCAN_MS),
      10_000,
      "MAILBOX_FULL_SCAN_MS",
    ),
    autoReply: parseBooleanEnv(optionalString(process.env.MAILBOX_AUTO_REPLY), false),
    maxMessagesPerTick: parsePositiveIntegerEnv(
      optionalString(process.env.MAILBOX_MAX_MESSAGES_PER_TICK),
      1,
      "MAILBOX_MAX_MESSAGES_PER_TICK",
    ),
    minSentAt: parseMailboxMinSentAt(optionalString(process.env.MAILBOX_MIN_SENT_AT)),
    promptTimeoutMs: parseOptionalPositiveIntegerEnv(
      optionalString(process.env.MAILBOX_PROMPT_TIMEOUT_MS),
      "MAILBOX_PROMPT_TIMEOUT_MS",
    ),
  };
}

function parseTelegramTransportConfig(): TelegramTransportConfig {
  const mcpServerName = optionalString(process.env.TELEGRAM_TRANSPORT_MCP_SERVER_NAME) ?? "telegram_transport";
  if (!isSafeMcpServerName(mcpServerName)) {
    throw new Error("TELEGRAM_TRANSPORT_MCP_SERVER_NAME must be a safe MCP server name");
  }

  return {
    enabled: parseBooleanEnv(optionalString(process.env.TELEGRAM_TRANSPORT_MCP_ENABLED), false),
    mcpServerName,
    personasStatePath:
      optionalString(process.env.TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH) ??
      path.join(homedir(), "code", "claude", "state", "personas.json"),
    blockedPersonaPrefixes: parseCommaList(
      optionalString(process.env.TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES),
      ["dadamia_"],
    ),
    autoApproveSends: parseBooleanEnv(
      optionalString(process.env.TELEGRAM_TRANSPORT_MCP_AUTO_APPROVE_SENDS),
      false,
    ),
    startupTimeoutMs: parsePositiveIntegerEnv(
      optionalString(process.env.TELEGRAM_TRANSPORT_MCP_STARTUP_TIMEOUT_MS),
      10_000,
      "TELEGRAM_TRANSPORT_MCP_STARTUP_TIMEOUT_MS",
    ),
    toolTimeoutMs: parsePositiveIntegerEnv(
      optionalString(process.env.TELEGRAM_TRANSPORT_MCP_TOOL_TIMEOUT_MS),
      30_000,
      "TELEGRAM_TRANSPORT_MCP_TOOL_TIMEOUT_MS",
    ),
  };
}

function parseLinearControlConfig(): LinearControlConfig {
  const enabled = parseBooleanEnv(optionalString(process.env.LINEAR_CONTROL_MCP_ENABLED), false);
  const mcpServerName = optionalString(process.env.LINEAR_CONTROL_MCP_SERVER_NAME) ?? "linear_control";
  if (!isSafeMcpServerName(mcpServerName)) {
    throw new Error("LINEAR_CONTROL_MCP_SERVER_NAME must be a safe MCP server name");
  }

  const allowedIssues = parseCommaList(optionalString(process.env.LINEAR_CONTROL_ALLOWED_ISSUES), [])
    .map((issue) => issue.toUpperCase());
  if (enabled && allowedIssues.length === 0) {
    throw new Error("LINEAR_CONTROL_ALLOWED_ISSUES must list at least one ALB issue");
  }
  for (const issue of allowedIssues) {
    if (!/^ALB-\d+$/.test(issue)) {
      throw new Error(`Invalid Linear control issue allowlist entry: ${issue}`);
    }
  }

  const apiKeyPath =
    optionalString(process.env.LINEAR_API_KEY_PATH) ??
    path.join(homedir(), ".config", "linear", "api_key");
  if (!path.isAbsolute(apiKeyPath)) {
    throw new Error("LINEAR_API_KEY_PATH must be an absolute path");
  }

  return {
    enabled,
    mcpServerName,
    allowedIssues,
    apiKeyPath,
    autoApproveEvidence: parseBooleanEnv(
      optionalString(process.env.LINEAR_CONTROL_MCP_AUTO_APPROVE_EVIDENCE),
      false,
    ),
    startupTimeoutMs: parsePositiveIntegerEnv(
      optionalString(process.env.LINEAR_CONTROL_MCP_STARTUP_TIMEOUT_MS),
      10_000,
      "LINEAR_CONTROL_MCP_STARTUP_TIMEOUT_MS",
    ),
    toolTimeoutMs: parsePositiveIntegerEnv(
      optionalString(process.env.LINEAR_CONTROL_MCP_TOOL_TIMEOUT_MS),
      30_000,
      "LINEAR_CONTROL_MCP_TOOL_TIMEOUT_MS",
    ),
  };
}

function validateMcpServerNames(
  telegramTransport: TelegramTransportConfig,
  linearControl: LinearControlConfig,
): void {
  if (
    telegramTransport.enabled &&
    linearControl.enabled &&
    telegramTransport.mcpServerName === linearControl.mcpServerName
  ) {
    throw new Error("Enabled MCP server names must be unique");
  }
}

function validateMailboxBridgeLaunch(
  mailboxBridge: MailboxBridgeConfig,
  launchProfiles: CodexLaunchProfile[],
  defaultLaunchProfileId: string,
): void {
  if (!mailboxBridge.enabled) {
    return;
  }

  if (mailboxBridge.persona && !isSafeMailboxSegment(mailboxBridge.persona)) {
    throw new Error("MAILBOX_PERSONA must be a safe single path segment");
  }

  const profile = findLaunchProfile(launchProfiles, defaultLaunchProfileId);
  if (profile?.sandboxMode === "read-only" && profile.approvalPolicy === "never") {
    return;
  }

  throw new Error("MAILBOX_PERSONA requires the default Codex launch profile to be read-only / never");
}

function parseMailboxMinSentAt(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  if (parseMailboxTimestampMs(raw) === undefined) {
    throw new Error("MAILBOX_MIN_SENT_AT must be an ISO or compact UTC timestamp");
  }

  return raw;
}

function parseOptionalPositiveIntegerEnv(raw: string | undefined, name: string): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseMailboxTimestampMs(value: string): number | undefined {
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
  if (!compact && !isoUtc) {
    return undefined;
  }
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isSafeMailboxSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function isSafeMcpServerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function parseCommaList(raw: string | undefined, defaultValue: string[]): string[] {
  if (!raw) {
    return defaultValue;
  }

  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : defaultValue;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "none";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "none".`,
      );
      return "none";
  }
}

function parseReasoningEffort(raw: string | undefined): CodexReasoningEffort | undefined {
  if (!raw) {
    return undefined;
  }

  switch (raw) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return raw;
    default:
      throw new Error(
        `Invalid CODEX_REASONING_EFFORT: ${raw}. Expected one of minimal, low, medium, high, xhigh`,
      );
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
