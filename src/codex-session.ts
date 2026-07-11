import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";

import type { TeleCodexConfig } from "./config.js";
import {
  getThread,
  getThreadContextUsage,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";

export interface AgentMessageDeliveryMetadata {
  isFinal: boolean;
  followedByTool: boolean;
}

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentMessage?: (text: string, metadata: AgentMessageDeliveryMetadata) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    lastContextTokens?: number;
    liveContextWindow?: number;
  }) => void;
}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  nextModel?: string;
  nextReasoningEffort?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: {
    input: number;
    cached: number;
    output: number;
  };
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  nextModel?: string;
  nextReasoningEffort?: string;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput = string | { text?: string; visibleText?: string; imagePaths?: string[]; stagedFileInstructions?: string };
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

export class CodexTurnAbortedError extends Error {
  constructor() {
    super("The operation was aborted");
    this.name = "CodexTurnAbortedError";
  }
}

export class CodexSessionService {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: ModelReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private activeThreadModel: string | undefined;
  private activeThreadReasoningEffort: ModelReasoningEffort | undefined;
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(private readonly config: TeleCodexConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodexConfig, options?: CreateOptions): Promise<CodexSessionService> {
    const service = new CodexSessionService(config);
    const activeModel = options?.model ?? config.codexModel;
    const activeReasoningEffort = (options?.reasoningEffort ?? config.codexReasoningEffort) as
      | ModelReasoningEffort
      | undefined;
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.nextModel ?? activeModel;
    service.currentReasoningEffort = (options?.nextReasoningEffort ?? activeReasoningEffort) as
      | ModelReasoningEffort
      | undefined;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );
    service.resetCodexClient();

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId, {
        model: activeModel,
        reasoningEffort: activeReasoningEffort,
      });
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const hasActiveThread = this.thread !== null;
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const effectiveModel = hasActiveThread
      ? this.activeThreadModel
      : (this.currentModel ?? this.config.codexModel);
    const effectiveReasoningEffort = hasActiveThread
      ? this.activeThreadReasoningEffort
      : this.currentReasoningEffort;
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      workspace: this.currentWorkspace,
      model: effectiveModel,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (effectiveReasoningEffort) {
      info.reasoningEffort = effectiveReasoningEffort;
    }

    if (hasActiveThread && this.currentModel && this.currentModel !== this.activeThreadModel) {
      info.nextModel = this.currentModel;
    }

    if (
      hasActiveThread &&
      this.currentReasoningEffort &&
      this.currentReasoningEffort !== this.activeThreadReasoningEffort
    ) {
      info.nextReasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null;
  }

  hasActiveThread(): boolean {
    return this.thread !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let lastAgentText = "";
    let pendingAgentMessage: string | null = null;
    const deliverPendingAgentMessage = (metadata: AgentMessageDeliveryMetadata): void => {
      if (pendingAgentMessage === null) {
        return;
      }
      const text = pendingAgentMessage;
      pendingAgentMessage = null;
      try {
        callbacks.onAgentMessage?.(text, metadata);
      } catch (error) {
        console.error("Agent message callback failed; continuing Codex event consumption:", error);
      }
    };

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of this.withAbort(events, controller.signal)) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (event.type === "item.started" && pendingAgentMessage !== null) {
              deliverPendingAgentMessage({
                isFinal: false,
                followedByTool: item.type !== "agent_message",
              });
            }
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                lastAgentText = item.text;
                callbacks.onTextDelta(delta);
              } else {
                lastAgentText = item.text;
              }
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              if (pendingAgentMessage !== null) {
                deliverPendingAgentMessage({ isFinal: false, followedByTool: false });
              }
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                callbacks.onTextDelta(delta);
              }
              lastAgentText = item.text;
              pendingAgentMessage = item.text;
            } else {
              if (pendingAgentMessage !== null) {
                deliverPendingAgentMessage({ isFinal: false, followedByTool: true });
              }
              if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
              } else if (item.type === "todo_list") {
                callbacks.onTodoUpdate?.(item.items);
              }
            }
            break;
          }
          case "turn.completed": {
            deliverPendingAgentMessage({ isFinal: true, followedByTool: false });
            // Accumulate and deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            this.sessionTokens.input += u.input_tokens;
            this.sessionTokens.cached += u.cached_input_tokens;
            this.sessionTokens.output += u.output_tokens;
            const threadId = this.thread?.id ?? this.currentThreadId;
            const contextUsage = threadId ? getThreadContextUsage(threadId) : null;
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
              ...(contextUsage
                ? {
                    lastContextTokens: contextUsage.contextTokens,
                    liveContextWindow: contextUsage.contextWindow,
                  }
                : {}),
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            deliverPendingAgentMessage({ isFinal: false, followedByTool: false });
            throw new Error(event.error.message);
          case "error":
            deliverPendingAgentMessage({ isFinal: false, followedByTool: false });
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  private async *withAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]();
    let fireAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      fireAbort = () => reject(new CodexTurnAbortedError());
      if (signal.aborted) {
        fireAbort();
      } else {
        signal.addEventListener("abort", fireAbort, { once: true });
      }
    });
    abortPromise.catch(() => {});

    try {
      while (true) {
        const result = await Promise.race([iterator.next(), abortPromise]);
        if (result.done) {
          return;
        }
        yield result.value;
      }
    } finally {
      if (fireAbort) {
        signal.removeEventListener("abort", fireAbort);
      }
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.activeThreadModel = effectiveModel ?? this.config.codexModel;
    this.activeThreadReasoningEffort = this.currentReasoningEffort;
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(
    threadId: string,
    options?: { model?: string; reasoningEffort?: ModelReasoningEffort },
  ): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    const activeModel = options?.model ?? this.currentModel;
    const activeReasoningEffort = options?.reasoningEffort ?? this.currentReasoningEffort;
    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(this.currentWorkspace, activeModel, activeReasoningEffort),
    );
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.activeThreadModel = activeModel ?? this.config.codexModel;
    this.activeThreadReasoningEffort = activeReasoningEffort;
    this.currentThreadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || undefined;

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.activeThreadModel = model ?? this.currentModel ?? this.config.codexModel;
    this.activeThreadReasoningEffort = this.currentReasoningEffort;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    return listThreads(limit ?? 20);
  }

  listWorkspaces(): string[] {
    return listWorkspaces();
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setReasoningEffort(effort: ModelReasoningEffort): void {
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.activeThreadModel = undefined;
    this.activeThreadReasoningEffort = undefined;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.activeThreadModel = undefined;
    this.activeThreadReasoningEffort = undefined;
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    if (typeof input === "string") {
      return input;
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildThreadOptions(workspace: string, model?: string, reasoningEffort?: ModelReasoningEffort): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
    modelReasoningEffort?: ModelReasoningEffort;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const effectiveReasoningEffort = reasoningEffort ?? this.currentReasoningEffort;
    const options = {
      model: effectiveModel,
      sandboxMode: this.currentLaunchProfile.sandboxMode,
      workingDirectory: workspace,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      skipGitRepoCheck: true as const,
    };

    if (effectiveReasoningEffort) {
      return {
        ...options,
        modelReasoningEffort: effectiveReasoningEffort,
      };
    }

    return options;
  }

  private ensureIdle(action: string): void {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
  }

  private resetCodexClient(): void {
    const configOverrides: CodexConfigObject = {
      approval_policy: this.currentLaunchProfile.approvalPolicy,
      features: { unified_exec: false },
    };
    const mcpServers: CodexConfigObject = {};
    const telegramTransportMcp = buildTelegramTransportMcpConfig(this.config);
    if (telegramTransportMcp) {
      mcpServers[this.config.telegramTransport.mcpServerName] = telegramTransportMcp;
    }
    const linearControlMcp = buildLinearControlMcpConfig(this.config);
    if (linearControlMcp) {
      mcpServers[this.config.linearControl.mcpServerName] = linearControlMcp;
    }
    const personaMailMcp = buildPersonaMailMcpConfig(this.config);
    if (personaMailMcp) {
      mcpServers.persona_mail = personaMailMcp;
    }
    if (Object.keys(mcpServers).length > 0) {
      configOverrides.mcp_servers = mcpServers;
    }

    this.codex = new Codex({
      codexPathOverride: this.config.codexPathOverride,
      apiKey: this.config.codexApiKey,
      config: configOverrides,
      env: buildCodexEnv(this.config),
    });
  }
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function buildTelegramTransportMcpConfig(config: TeleCodexConfig): CodexConfigObject | undefined {
  if (!config.telegramTransport.enabled) {
    return undefined;
  }

  const command = buildTelegramTransportMcpCommand();
  const mcpConfig: CodexConfigObject = {
    command: command.command,
    args: command.args,
    env_vars: [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH",
      "TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES",
    ],
    enabled_tools: ["send_cross_persona_message"],
    startup_timeout_sec: Math.ceil(config.telegramTransport.startupTimeoutMs / 1000),
    tool_timeout_sec: Math.ceil(config.telegramTransport.toolTimeoutMs / 1000),
  };

  if (config.telegramTransport.autoApproveSends) {
    mcpConfig.default_tools_approval_mode = "approve";
  }

  return mcpConfig;
}

function buildTelegramTransportMcpCommand(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".ts")) {
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("./telegram-transport-mcp-server.ts", import.meta.url)),
      ],
    };
  }

  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./telegram-transport-mcp-server.js", import.meta.url))],
  };
}

function buildLinearControlMcpConfig(config: TeleCodexConfig): CodexConfigObject | undefined {
  if (!config.linearControl.enabled) {
    return undefined;
  }

  const command = buildLinearControlMcpCommand();
  const mcpConfig: CodexConfigObject = {
    command: command.command,
    args: command.args,
    env_vars: ["LINEAR_API_KEY_PATH", "LINEAR_CONTROL_ALLOWED_ISSUES"],
    enabled_tools: ["add_linear_evidence"],
    startup_timeout_sec: Math.ceil(config.linearControl.startupTimeoutMs / 1000),
    tool_timeout_sec: Math.ceil(config.linearControl.toolTimeoutMs / 1000),
  };

  if (config.linearControl.autoApproveEvidence) {
    mcpConfig.default_tools_approval_mode = "approve";
  }

  return mcpConfig;
}

function buildLinearControlMcpCommand(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".ts")) {
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("./linear-control-mcp-server.ts", import.meta.url)),
      ],
    };
  }

  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./linear-control-mcp-server.js", import.meta.url))],
  };
}

function buildPersonaMailMcpConfig(config: TeleCodexConfig): CodexConfigObject | undefined {
  if (!config.mailboxBridge.enabled || !config.mailboxBridge.persona) {
    return undefined;
  }

  const command = buildPersonaMailMcpCommand();
  return {
    command: command.command,
    args: command.args,
    env_vars: ["PERSONAS_ROOT", "MAILBOX_PERSONA"],
    enabled_tools: ["send_persona_mail"],
    default_tools_approval_mode: "approve",
    startup_timeout_sec: 10,
    tool_timeout_sec: 30,
  };
}

function buildPersonaMailMcpCommand(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".ts")) {
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
        fileURLToPath(new URL("./persona-mail-mcp-server.ts", import.meta.url)),
      ],
    };
  }

  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./persona-mail-mcp-server.js", import.meta.url))],
  };
}
function buildCodexEnv(config: TeleCodexConfig): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.LINEAR_API_KEY;

  if (config.codexApiKey) {
    env.CODEX_API_KEY = config.codexApiKey;
  }

  if (config.telegramTransport.enabled) {
    env.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
    env.TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH = config.telegramTransport.personasStatePath;
    env.TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES = config.telegramTransport.blockedPersonaPrefixes.join(",");
  }

  if (config.linearControl.enabled) {
    env.LINEAR_API_KEY_PATH = config.linearControl.apiKeyPath;
    env.LINEAR_CONTROL_ALLOWED_ISSUES = config.linearControl.allowedIssues.join(",");
  }

  if (config.mailboxBridge.enabled && config.mailboxBridge.persona) {
    env.PERSONAS_ROOT = config.mailboxBridge.personasRoot;
    env.MAILBOX_PERSONA = config.mailboxBridge.persona;
  }

  return env;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
