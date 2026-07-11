import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodexPromptInput, CodexSessionCallbacks, CodexSessionService } from "./codex-session.js";
import type { MailboxBridgeConfig, TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { DEFAULT_MAX_ENTRY_CHARS } from "./handoff-buffer.js";
import { loadChatState, saveChatState } from "./handoff-store.js";
import { stripVisiblePromptGuardEcho, withDispatcherDisciplineGuard, withRotationHandoff } from "./prompt-guard.js";
import type { SessionRegistry } from "./session-registry.js";
import {
  type ChatRotationState,
  type RotationConfig,
  emptyChatState,
  recordInterruptedTurn,
  recordTurn,
  takeRotationHandoff,
} from "./thread-rotation.js";

const MAILBOX_REL = ["_shared", "memory", "mailbox"] as const;
const BRIDGE_DELIVERED_BY = "telecodex-mailbox-bridge";
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface MailboxMessage {
  from: string;
  to: string;
  sentAt: string;
  msgId: string;
  status: string;
  inReplyTo?: string;
  subject: string;
  priority: string;
  humanAuthorizedBy: string;
  body: string;
  path: string;
}

interface DeliveryEvent {
  msgId: string;
  sentAt: string;
  path: string;
}

interface SeenMessageState {
  processedAt: string;
  from: string;
  path: string;
  status?: string;
  failureReason?: string;
}

interface SeenState {
  messages: Record<string, SeenMessageState>;
}

export interface MailboxDeliveryResult {
  processed: number;
  replied: number;
  skipped: number;
}

export interface MailboxRecoveryOptions {
  onFatalRecovery?: (error: Error) => void;
}

const MAILBOX_PROMPT_TIMEOUT_STATUS = "failed_prompt_timeout";
const MAILBOX_UNEXPECTED_FAILURE_STATUS = "failed_unexpected";
const MAILBOX_PROCESSING_STATUS = "processing";
const MAILBOX_TERMINAL_STATUSES = new Set([
  "processed",
  MAILBOX_PROMPT_TIMEOUT_STATUS,
  MAILBOX_UNEXPECTED_FAILURE_STATUS,
]);

export async function runMailboxDeliveryOnce(
  config: TeleCodexConfig,
  registry: Pick<SessionRegistry, "getOrCreate" | "updateMetadata">,
  recoveryOptions: MailboxRecoveryOptions = {},
): Promise<MailboxDeliveryResult> {
  const settings = config.mailboxBridge;
  if (!settings.enabled || !settings.persona) {
    return { processed: 0, replied: 0, skipped: 0 };
  }
  assertSafeSegment(settings.persona, "MAILBOX_PERSONA");

  const contextKey = mailboxContextKey(settings);
  const abortGraceMs = mailboxAbortGraceMs(config);
  const onFatalRecovery = mailboxFatalRecovery(recoveryOptions);
  const statePath = mailboxSeenStatePath(config.workspace, settings.persona);
  const seen = await loadSeenState(statePath);
  const events = await listDeliveryEvents(settings);
  const eventMsgIds = new Set(events.map((event) => event.msgId));
  const inboxMessages = await listInboxMessages(settings);
  const staleClaimsQuarantined = await quarantineStaleMailboxClaims(
    settings,
    statePath,
    seen,
    inboxMessages,
  );
  const unseenMessages = inboxMessages.filter((msg) => !seen.messages[msg.msgId]);
  const historicalMessages = unseenMessages.filter((msg) => !isAfterMinSentAt(settings, msg));
  const historicalSkipped = await markHistoricalSkipped(settings, statePath, seen, historicalMessages);
  const skippedBeforeDelivery = historicalSkipped + staleClaimsQuarantined;
  const unreadMessages = unseenMessages.filter((msg) => isAfterMinSentAt(settings, msg));
  const eventBackedMessages = eventMsgIds.size > 0
    ? unreadMessages.filter((msg) => eventMsgIds.has(msg.msgId))
    : unreadMessages;
  const messages = (eventBackedMessages.length > 0 ? eventBackedMessages : unreadMessages)
    .slice(0, settings.maxMessagesPerTick);

  if (messages.length === 0) {
    await ackSeenEvents(settings, events, seen);
    return { processed: 0, replied: 0, skipped: skippedBeforeDelivery };
  }

  const session = settings.launchProfileId
    ? await registry.getOrCreate(contextKey, { launchProfileId: settings.launchProfileId })
    : await registry.getOrCreate(contextKey);
  ensureMailboxSessionLaunchProfile(session, settings.allowUnsafeLaunchProfile);
  let processed = 0;
  let replied = 0;
  let skipped = skippedBeforeDelivery;

  // Auto-rotation for the mailbox thread (ALB-1205). Worker bots (Theo/Ada) run
  // most of their turns through this bridge on a thread that persists across
  // ticks, so this is the main path where context grows to the ceiling. State is
  // persisted per mailbox contextKey and survives ticks / restarts.
  const rotationCfg = mailboxRotationConfig(config);
  const rotationStateDir = path.join(config.workspace, ".telecodex");
  let rotationState: ChatRotationState = rotationCfg.enabled
    ? loadChatState(rotationStateDir, contextKey)
    : emptyChatState();
  const persistRotationState = (): void => {
    if (!rotationCfg.enabled) {
      return;
    }
    try {
      saveChatState(rotationStateDir, contextKey, rotationState);
    } catch (error) {
      console.error("mailbox rotation state persist failed:", error instanceof Error ? error.message : String(error));
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (session.isProcessing()) {
      skipped += 1;
      break;
    }

    await claimMailboxMessage(statePath, seen, message);
    let deliveryError: unknown;

    try {
      // Rotate before the turn when a prior turn crossed the threshold; otherwise
      // keep the existing thread (opening one only if none is active yet).
      let rotationHandoff: string | null = null;
      if (rotationCfg.enabled) {
        const unanswered = messages.slice(index + 1).map(mailboxTurnDescriptor);
        const taken = takeRotationHandoff(rotationState, rotationCfg, { unanswered });
        if (taken.handoff) {
          // A mandatory (hard-cap) rotation must not fall back to the over-cap thread:
          // try once more before giving up, and if it still fails, refuse this turn and
          // leave the message for a later tick. The pending rotation is preserved because
          // taken.state is only adopted on success. Mirrors the Telegram path (ALB-1205).
          const maxNewThreadAttempts = taken.mandatory ? 2 : 1;
          let rotated = false;
          let lastNewThreadError: unknown;
          for (let attempt = 0; attempt < maxNewThreadAttempts; attempt += 1) {
            try {
              await session.newThread();
              rotated = true;
              break;
            } catch (error) {
              lastNewThreadError = error;
            }
          }
          if (rotated) {
            rotationState = taken.state;
            rotationHandoff = taken.handoff;
            persistRotationState();
            console.error(
              `Auto-rotated Codex mailbox thread for ${contextKey} on context pressure (ALB-1205).`,
            );
          } else if (taken.mandatory) {
            console.error(
              "mailbox mandatory auto-rotation newThread failed; deferring the message rather than running it on the over-cap thread (ALB-1205):",
              lastNewThreadError instanceof Error ? lastNewThreadError.message : String(lastNewThreadError),
            );
            await releaseMailboxClaim(statePath, seen, message);
            skipped += 1;
            break;
          } else {
            console.error(
              "mailbox auto-rotation newThread failed; continuing on the existing thread:",
              lastNewThreadError instanceof Error ? lastNewThreadError.message : String(lastNewThreadError),
            );
            if (!session.hasActiveThread()) {
              await session.newThread();
            }
          }
        } else if (!session.hasActiveThread()) {
          await session.newThread();
        }
      } else if (!session.hasActiveThread()) {
        await session.newThread();
      }

      const outcome = await promptMailboxMessage(
        session,
        message,
        settings.promptTimeoutMs,
        abortGraceMs,
        rotationHandoff,
      );
      const finalText = outcome.text;
      const turnUsage = outcome.usage;

      if (rotationCfg.enabled) {
        rotationState = recordTurn(
          rotationState,
          {
            userText: mailboxTurnDescriptor(message),
            assistantText: finalText,
            lastInputTokens: turnUsage?.inputTokens,
            lastContextTokens: turnUsage?.lastContextTokens,
            liveContextWindow: turnUsage?.liveContextWindow,
          },
          rotationCfg,
        );
        persistRotationState();
      }

      if (shouldWriteReply(settings, message, finalText)) {
        await sendMailboxReply(settings, message, finalText.trim());
        replied += 1;
      }

      const archivePath = await archiveInboxMessage(settings, message);
      await recordDeliveryReceipt(settings, message, "processed", archivePath);
      await ackDeliveryEvents(settings, message.msgId);
      seen.messages[message.msgId] = {
        processedAt: new Date().toISOString(),
        from: message.from,
        path: archivePath,
        status: "processed",
      };
      await saveSeenState(statePath, seen);
      await unlink(message.path).catch(() => undefined);
      try {
        registry.updateMetadata(contextKey, session);
      } catch (error) {
        console.error(
          "mailbox registry metadata update failed after durable completion:",
          error instanceof Error ? error.message : String(error),
        );
      }
      processed += 1;
    } catch (error) {
      deliveryError = error;
    }

    if (!deliveryError) {
      continue;
    }

    if (deliveryError instanceof MailboxPromptTimeoutError) {
      // A turn cut short by the timeout on an already-heavy thread becomes a
      // rotation breakpoint: the next thread's HANDOFF resumes it (ALB-1205).
      let retryInterruptedMessage = false;
      if (rotationCfg.enabled) {
        rotationState = recordInterruptedTurn(rotationState, mailboxTurnDescriptor(message), rotationCfg);
        retryInterruptedMessage = rotationState.interruptedAttempts === 1;
        persistRotationState();
      }
      if (retryInterruptedMessage) {
        await releaseMailboxClaim(statePath, seen, message);
      } else {
        await quarantineTimedOutMailboxMessage(settings, statePath, seen, message);
      }
      deliveryError.startAbortGrace(onFatalRecovery);
      registry.updateMetadata(contextKey, session);
      skipped += 1;
      break;
    }

    await quarantineUnexpectedMailboxMessage(settings, statePath, seen, message, deliveryError);
    try {
      registry.updateMetadata(contextKey, session);
    } catch (error) {
      console.error(
        "mailbox registry metadata update failed after unexpected quarantine:",
        error instanceof Error ? error.message : String(error),
      );
    }
    skipped += 1;
    break;
  }

  return { processed, replied, skipped };
}

export function startMailboxBridge(
  config: TeleCodexConfig,
  registry: Pick<SessionRegistry, "getOrCreate" | "updateMetadata">,
  options: MailboxRecoveryOptions = {},
): (() => void) | undefined {
  const settings = config.mailboxBridge;
  if (!settings.enabled || !settings.persona) {
    return undefined;
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runMailboxDeliveryOnce(config, registry, options);
      if (result.processed || result.skipped) {
        console.log(
          `mailbox bridge tick persona=${settings.persona} processed=${result.processed} replied=${result.replied} skipped=${result.skipped}`,
        );
      }
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      console.error("mailbox bridge tick failed:", normalizedError.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, settings.pollMs);
  timer.unref?.();
  void tick();

  return () => {
    clearInterval(timer);
  };
}

function mailboxContextKey(settings: MailboxBridgeConfig): TelegramContextKey {
  return (settings.contextKey ?? `mailbox:${settings.persona}`) as TelegramContextKey;
}

function mailboxAbortGraceMs(config: TeleCodexConfig): number | undefined {
  if (!config.mailboxBridge.promptTimeoutMs) {
    return undefined;
  }
  return config.codexTurnAbortGraceMs ?? config.mailboxBridge.promptTimeoutMs;
}

function mailboxFatalRecovery(options: MailboxRecoveryOptions): (error: Error) => void {
  return options.onFatalRecovery ?? ((error: Error) => {
    setImmediate(() => {
      throw error;
    });
  });
}

function mailboxRoot(settings: MailboxBridgeConfig): string {
  return path.resolve(settings.personasRoot, ...MAILBOX_REL);
}

function isAfterMinSentAt(settings: MailboxBridgeConfig, message: MailboxMessage): boolean {
  if (!settings.minSentAt) {
    return true;
  }
  const messageTime = parseMailboxTimestampMs(message.sentAt);
  const minTime = parseMailboxTimestampMs(settings.minSentAt);
  if (messageTime === undefined) {
    return false;
  }
  if (minTime === undefined) {
    throw new Error("MAILBOX_MIN_SENT_AT must be an ISO or compact UTC timestamp");
  }
  return messageTime >= minTime;
}

async function markHistoricalSkipped(
  settings: MailboxBridgeConfig,
  statePath: string,
  seen: SeenState,
  messages: MailboxMessage[],
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }

  const processedAt = new Date().toISOString();
  for (const message of messages) {
    seen.messages[message.msgId] = {
      processedAt,
      from: message.from,
      path: message.path,
      status: "skipped_before_min_sent_at",
    };
    await ackDeliveryEvents(settings, message.msgId);
  }
  await saveSeenState(statePath, seen);
  return messages.length;
}

function inboxDir(settings: MailboxBridgeConfig, persona: string): string {
  return mailboxPath(settings, safeSegment(persona), "inbox");
}

function archiveDir(settings: MailboxBridgeConfig, persona: string, month: string): string {
  return mailboxPath(settings, safeSegment(persona), "archive", safeSegment(month));
}

function eventsDir(settings: MailboxBridgeConfig, persona: string): string {
  return mailboxPath(settings, "_events", safeSegment(persona));
}

function receiptsDir(settings: MailboxBridgeConfig, persona: string): string {
  return mailboxPath(settings, "_receipts", safeSegment(persona));
}

async function listInboxMessages(settings: MailboxBridgeConfig): Promise<MailboxMessage[]> {
  const persona = settings.persona;
  if (!persona) {
    return [];
  }

  const dir = inboxDir(settings, persona);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const messages: MailboxMessage[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === "README.md") {
      continue;
    }
    const file = path.join(dir, name);
    const message = await readMailboxMessage(file);
    if (message?.status === "unread" && message.to === persona) {
      messages.push(message);
    }
  }

  messages.sort((left, right) => left.sentAt.localeCompare(right.sentAt));
  return messages;
}

async function readMailboxMessage(file: string): Promise<MailboxMessage | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseFrontmatter(text);
  if (!parsed) {
    return undefined;
  }

  const msgId = safeOptionalSegment(parsed.frontmatter.msg_id);
  const from = safeOptionalSegment(parsed.frontmatter.from);
  const to = safeOptionalSegment(parsed.frontmatter.to);
  if (!msgId || !from || !to) {
    return undefined;
  }

  return {
    from,
    to,
    sentAt: parsed.frontmatter.sent_at?.trim() || "",
    msgId,
    status: parsed.frontmatter.status?.trim() || "unread",
    inReplyTo: optionalMailboxField(parsed.frontmatter.in_reply_to),
    subject: parsed.frontmatter.subject?.trim() || "(no subject)",
    priority: parsed.frontmatter.priority?.trim() || "P2",
    humanAuthorizedBy: parsed.frontmatter.human_authorized_by?.trim() || "",
    body: parsed.body.trim(),
    path: file,
  };
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
  if (!match) {
    return undefined;
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return { frontmatter, body: match[2] ?? "" };
}

async function listDeliveryEvents(settings: MailboxBridgeConfig): Promise<DeliveryEvent[]> {
  const persona = settings.persona;
  if (!persona) {
    return [];
  }

  const dir = eventsDir(settings, persona);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const events: DeliveryEvent[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      if (raw.to !== persona || typeof raw.msg_id !== "string" || !isSafeSegment(raw.msg_id)) {
        continue;
      }
      events.push({
        msgId: raw.msg_id,
        sentAt: typeof raw.sent_at === "string" ? raw.sent_at : "",
        path: file,
      });
    } catch {
      continue;
    }
  }

  events.sort((left, right) => left.sentAt.localeCompare(right.sentAt));
  return events;
}

async function promptMailboxMessage(
  session: CodexSessionService,
  message: MailboxMessage,
  timeoutMs?: number,
  abortGraceMs?: number,
  rotationHandoff?: string | null,
): Promise<{
  text: string;
  usage?: { inputTokens: number; lastContextTokens?: number; liveContextWindow?: number };
}> {
  let accumulatedText = "";
  let completedAgentText = "";
  let lastUsage: { inputTokens: number; lastContextTokens?: number; liveContextWindow?: number } | undefined;
  const callbacks: CodexSessionCallbacks = {
    onTextDelta: (delta) => {
      accumulatedText += delta;
    },
    onToolStart: () => undefined,
    onToolUpdate: () => undefined,
    onToolEnd: () => undefined,
    onAgentMessage: (text) => {
      completedAgentText = text;
    },
    onTurnComplete: (usage) => {
      lastUsage = usage;
    },
    onAgentEnd: () => undefined,
  };

  const basePrompt = withDispatcherDisciplineGuard(renderCodexMailboxPrompt(message), session.getInfo());
  const promptPromise = session.prompt(
    rotationHandoff ? withRotationHandoff(basePrompt, rotationHandoff) : basePrompt,
    callbacks,
  );
  await awaitMailboxPrompt(session, promptPromise, timeoutMs, abortGraceMs);
  return { text: stripVisiblePromptGuardEcho(completedAgentText || accumulatedText), usage: lastUsage };
}

/**
 * Compact one-line descriptor of a mailbox turn for the rotation buffer/HANDOFF.
 *
 * Carries a bounded body excerpt (契约 §A.4 保真度): a subject-only descriptor
 * loses "那封信要干嘛" across a rotation — worst at the interrupted breakpoint,
 * where the letter being answered would survive as nothing but a title. The
 * excerpt is collapsed to a single line and cut at the same per-entry cap the
 * HANDOFF renderer uses for Telegram turns, so both paths keep equal fidelity
 * and the renderer's per-entry/total budgets stay the backstop.
 */
function mailboxTurnDescriptor(message: MailboxMessage): string {
  const subjectLine = `[内部信] ${message.from} → ${message.subject}`;
  // The mailbox writer duplicates the subject as a leading `# <subject>` heading
  // inside the body; the descriptor already carries the subject, so drop the
  // duplicate (a genuine content heading that differs stays).
  let rawBody = message.body.trim();
  const firstLineEnd = rawBody.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? rawBody : rawBody.slice(0, firstLineEnd);
  const heading = /^#{1,6}\s+(.*)$/.exec(firstLine.trim());
  if (heading && heading[1]!.trim() === message.subject) {
    rawBody = firstLineEnd === -1 ? "" : rawBody.slice(firstLineEnd + 1);
  }
  const body = rawBody.replace(/\s+/g, " ").trim();
  if (!body) {
    return subjectLine;
  }
  const excerpt =
    body.length > DEFAULT_MAX_ENTRY_CHARS ? body.slice(0, DEFAULT_MAX_ENTRY_CHARS) + "…" : body;
  return `${subjectLine} | 正文摘录: ${excerpt}`;
}

function mailboxRotationConfig(config: TeleCodexConfig): RotationConfig {
  const rotate = config.autoRotate;
  return {
    enabled: rotate?.enabled ?? false,
    threshold: rotate?.threshold ?? 0,
    hardCap: rotate?.hardCap,
    contextWindow: rotate?.contextWindow ?? 0,
  };
}

async function awaitMailboxPrompt(
  session: CodexSessionService,
  promptPromise: Promise<void>,
  timeoutMs?: number,
  abortGraceMs?: number,
): Promise<void> {
  if (!timeoutMs) {
    await promptPromise;
    return;
  }

  let timedOut = false;
  let promptSettled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  const startAbortGrace = (onFatalRecovery: (error: Error) => void): void => {
    if (!abortGraceMs || promptSettled || !session.isProcessing()) {
      return;
    }
    abortGraceTimeout = setTimeout(() => {
      if (promptSettled || !session.isProcessing()) {
        return;
      }
      onFatalRecovery(new MailboxPromptAbortGraceError(timeoutMs, abortGraceMs));
    }, abortGraceMs);
  };
  const markPromptSettled = (): void => {
    promptSettled = true;
    if (abortGraceTimeout) {
      clearTimeout(abortGraceTimeout);
      abortGraceTimeout = undefined;
    }
  };
  const observedPromptPromise = promptPromise.then(
    () => {
      markPromptSettled();
    },
    (error) => {
      markPromptSettled();
      if (timedOut) {
        return;
      }
      throw error;
    },
  );
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void session.abort().catch((error) => {
        console.error("mailbox bridge abort after prompt timeout failed:", error instanceof Error ? error.message : String(error));
      });
      reject(new MailboxPromptTimeoutError(timeoutMs, startAbortGrace));
    }, timeoutMs);
  });

  try {
    await Promise.race([observedPromptPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class MailboxPromptTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    readonly startAbortGrace: (onFatalRecovery: (error: Error) => void) => void,
  ) {
    super(`Mailbox Codex turn timed out after ${timeoutMs}ms`);
    this.name = "MailboxPromptTimeoutError";
  }
}

class MailboxPromptAbortGraceError extends Error {
  constructor(timeoutMs: number, abortGraceMs: number) {
    super(`Mailbox Codex turn remained active after timeout abort grace (${timeoutMs}ms timeout, ${abortGraceMs}ms grace)`);
    this.name = "MailboxPromptAbortGraceError";
  }
}

interface ExistingTerminalReceipt {
  status: string;
  failureReason?: string;
  recordedAt?: string;
  messagePath?: string;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function expectedTerminalMessagePath(
  settings: MailboxBridgeConfig,
  message: MailboxMessage,
  status: string,
): string {
  return status === "processed"
    ? path.join(archiveDir(settings, message.to, mailboxMonth(message.sentAt)), path.basename(message.path))
    : message.path;
}

async function loadExistingTerminalReceipt(
  settings: MailboxBridgeConfig,
  message: MailboxMessage,
): Promise<ExistingTerminalReceipt | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(receiptsDir(settings, message.to), message.msgId + ".json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.msg_id !== message.msgId ||
      typeof parsed.status !== "string" ||
      !MAILBOX_TERMINAL_STATUSES.has(parsed.status) ||
      parsed.from !== message.from ||
      parsed.to !== message.to ||
      parsed.delivered_by !== BRIDGE_DELIVERED_BY ||
      typeof parsed.message_path !== "string" ||
      !isPathWithin(mailboxRoot(settings), parsed.message_path) ||
      path.resolve(parsed.message_path) !==
        path.resolve(expectedTerminalMessagePath(settings, message, parsed.status))
    ) {
      return null;
    }
    return {
      status: parsed.status,
      failureReason: typeof parsed.failure_reason === "string" ? parsed.failure_reason : undefined,
      recordedAt: typeof parsed.recorded_at === "string" ? parsed.recorded_at : undefined,
      messagePath: typeof parsed.message_path === "string" ? parsed.message_path : undefined,
    };
  } catch {
    return null;
  }
}

async function quarantineStaleMailboxClaims(
  settings: MailboxBridgeConfig,
  statePath: string,
  seen: SeenState,
  inboxMessages: MailboxMessage[],
): Promise<number> {
  const staleMessages = inboxMessages.filter(
    (message) => seen.messages[message.msgId]?.status === MAILBOX_PROCESSING_STATUS,
  );
  if (staleMessages.length === 0) {
    return 0;
  }

  const interruptedReason = "interrupted_before_terminal_state";
  for (const message of staleMessages) {
    const existingReceipt = await loadExistingTerminalReceipt(settings, message);
    const failureReason = existingReceipt?.failureReason ?? (
      existingReceipt ? undefined : interruptedReason
    );
    seen.messages[message.msgId] = {
      processedAt: existingReceipt?.recordedAt ?? new Date().toISOString(),
      from: message.from,
      path: existingReceipt?.messagePath ?? message.path,
      status: existingReceipt?.status ?? MAILBOX_UNEXPECTED_FAILURE_STATUS,
      ...(failureReason ? { failureReason } : {}),
    };

    const persistenceErrors: string[] = [];
    if (!existingReceipt) {
      try {
        await recordDeliveryReceipt(
          settings,
          message,
          MAILBOX_UNEXPECTED_FAILURE_STATUS,
          message.path,
          interruptedReason,
        );
      } catch (receiptError) {
        persistenceErrors.push(
          "receipt: " + (receiptError instanceof Error ? receiptError.message : String(receiptError)),
        );
      }
    }
    try {
      await saveSeenState(statePath, seen);
    } catch (seenError) {
      persistenceErrors.push(
        "seen: " + (seenError instanceof Error ? seenError.message : String(seenError)),
      );
    }
    try {
      await ackDeliveryEvents(settings, message.msgId);
    } catch (eventError) {
      persistenceErrors.push(
        "event: " + (eventError instanceof Error ? eventError.message : String(eventError)),
      );
    }

    console.error(
      (
        existingReceipt
          ? "mailbox message " + message.msgId + " restored from terminal receipt after stale claim"
          : "mailbox message " + message.msgId + " quarantined from stale processing claim after restart"
      ) + (persistenceErrors.length > 0 ? "; persistence warnings: " + persistenceErrors.join("; ") : ""),
    );
  }
  return staleMessages.length;
}

async function claimMailboxMessage(
  statePath: string,
  seen: SeenState,
  message: MailboxMessage,
): Promise<void> {
  seen.messages[message.msgId] = {
    processedAt: new Date().toISOString(),
    from: message.from,
    path: message.path,
    status: MAILBOX_PROCESSING_STATUS,
  };
  await saveSeenState(statePath, seen);
}

async function releaseMailboxClaim(
  statePath: string,
  seen: SeenState,
  message: MailboxMessage,
): Promise<void> {
  delete seen.messages[message.msgId];
  await saveSeenState(statePath, seen);
}

async function quarantineUnexpectedMailboxMessage(
  settings: MailboxBridgeConfig,
  statePath: string,
  seen: SeenState,
  message: MailboxMessage,
  error: unknown,
): Promise<void> {
  const errorText = error instanceof Error ? error.message : String(error);
  seen.messages[message.msgId] = {
    processedAt: new Date().toISOString(),
    from: message.from,
    path: message.path,
    status: MAILBOX_UNEXPECTED_FAILURE_STATUS,
    failureReason: errorText,
  };

  const persistenceErrors: string[] = [];
  try {
    await recordDeliveryReceipt(
      settings,
      message,
      MAILBOX_UNEXPECTED_FAILURE_STATUS,
      message.path,
      errorText,
    );
  } catch (receiptError) {
    persistenceErrors.push(
      `receipt: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`,
    );
  }
  try {
    await saveSeenState(statePath, seen);
  } catch (seenError) {
    persistenceErrors.push(
      `seen: ${seenError instanceof Error ? seenError.message : String(seenError)}`,
    );
  }
  try {
    await ackDeliveryEvents(settings, message.msgId);
  } catch (eventError) {
    persistenceErrors.push(
      `event: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
    );
  }

  console.error(
    `mailbox message ${message.msgId} quarantined after unexpected failure: ${errorText}` +
      (persistenceErrors.length > 0 ? `; persistence warnings: ${persistenceErrors.join("; ")}` : ""),
  );
}

async function quarantineTimedOutMailboxMessage(
  settings: MailboxBridgeConfig,
  statePath: string,
  seen: SeenState,
  message: MailboxMessage,
): Promise<void> {
  await recordDeliveryReceipt(settings, message, MAILBOX_PROMPT_TIMEOUT_STATUS, message.path);
  seen.messages[message.msgId] = {
    processedAt: new Date().toISOString(),
    from: message.from,
    path: message.path,
    status: MAILBOX_PROMPT_TIMEOUT_STATUS,
  };
  await saveSeenState(statePath, seen);
  await ackDeliveryEvents(settings, message.msgId);
}

function ensureMailboxSessionLaunchProfile(session: CodexSessionService, allowUnsafeLaunchProfile: boolean): void {
  const info = session.getInfo();
  if (allowUnsafeLaunchProfile) {
    if (info.approvalPolicy === "never") {
      return;
    }
    throw new Error("MAILBOX_ALLOW_UNSAFE_LAUNCH_PROFILE requires a never approval Codex session");
  }

  if (info.sandboxMode === "read-only" && info.approvalPolicy === "never") {
    return;
  }

  throw new Error("Mailbox bridge requires a read-only / never Codex session");
}

function renderCodexMailboxPrompt(message: MailboxMessage): CodexPromptInput {
  return [
    "[cross-persona realtime mailbox]",
    `from: ${message.from}`,
    `to: ${message.to}`,
    `sent_at: ${message.sentAt}`,
    `msg_id: ${message.msgId}`,
    `subject: ${message.subject}`,
    "",
    "This is an internal bot-to-bot mailbox turn delivered by the TeleCodex bridge.",
    "Do not send Telegram messages for this turn.",
    "If a reply to the sender is useful, make your final answer exactly the reply body.",
    "If no reply is needed, make your final answer exactly NO_REPLY.",
    "The bridge will write your final reply back to the sender mailbox and mark this incoming message read.",
    "",
    message.body.trim(),
    "",
  ].join("\n");
}

function shouldWriteReply(settings: MailboxBridgeConfig, message: MailboxMessage, text: string): boolean {
  if (!settings.autoReply) {
    return false;
  }
  if (message.inReplyTo) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized !== "noreply";
}

async function sendMailboxReply(
  settings: MailboxBridgeConfig,
  incoming: MailboxMessage,
  body: string,
): Promise<string> {
  const sender = incoming.to;
  const recipient = incoming.from;
  const msgId = `reply-${incoming.msgId}`;
  const sentAt = currentMailboxTimestamp();
  const dir = inboxDir(settings, recipient);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sender}-reply-${safeFilePart(incoming.msgId)}.md`);
  await writeAtomic(
    file,
    renderMailboxFile({
      from: sender,
      to: recipient,
      sentAt,
      msgId,
      status: "unread",
      inReplyTo: incoming.msgId,
      subject: incoming.subject.startsWith("Re:") ? incoming.subject : `Re: ${incoming.subject}`,
      priority: "P2",
      humanAuthorizedBy: "",
      body,
    }),
  );
  await writeDeliveryEvent(settings, {
    from: sender,
    to: recipient,
    sentAt,
    msgId,
    subject: incoming.subject.startsWith("Re:") ? incoming.subject : `Re: ${incoming.subject}`,
    messagePath: file,
  });
  return file;
}

function renderMailboxFile(input: {
  from: string;
  to: string;
  sentAt: string;
  msgId: string;
  status: string;
  inReplyTo?: string;
  subject: string;
  priority: string;
  humanAuthorizedBy: string;
  body: string;
}): string {
  return [
    "---",
    `from: ${input.from}`,
    `to: ${input.to}`,
    `sent_at: ${input.sentAt}`,
    `msg_id: ${input.msgId}`,
    `status: ${input.status}`,
    `in_reply_to: ${input.inReplyTo ?? ""}`,
    `subject: ${input.subject}`,
    `priority: ${input.priority}`,
    `human_authorized_by: ${input.humanAuthorizedBy}`,
    "---",
    `# ${input.subject}`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

async function writeDeliveryEvent(
  settings: MailboxBridgeConfig,
  input: {
    from: string;
    to: string;
    sentAt: string;
    msgId: string;
    subject: string;
    messagePath: string;
  },
): Promise<void> {
  const dir = eventsDir(settings, input.to);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "archive"), { recursive: true });
  const eventPath = path.join(
    dir,
    `${safeFilePart(input.msgId)}.json`,
  );
  await writeAtomicJson(eventPath, {
    event_id: `mailbox:${input.msgId}`,
    type: "persona_mail.created",
    from: input.from,
    to: input.to,
    sent_at: input.sentAt,
    msg_id: input.msgId,
    subject: input.subject,
    message_path: input.messagePath,
    created_at: new Date().toISOString(),
  });
}

async function archiveInboxMessage(settings: MailboxBridgeConfig, message: MailboxMessage): Promise<string> {
  const month = mailboxMonth(message.sentAt);
  const dir = archiveDir(settings, message.to, month);
  await mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, path.basename(message.path));
  await writeAtomic(
    archivePath,
    renderMailboxFile({
      from: message.from,
      to: message.to,
      sentAt: message.sentAt,
      msgId: message.msgId,
      status: "read",
      inReplyTo: message.inReplyTo,
      subject: message.subject,
      priority: message.priority,
      humanAuthorizedBy: message.humanAuthorizedBy,
      body: stripMailboxTitle(message),
    }),
  );
  return archivePath;
}

async function ackDeliveryEvents(settings: MailboxBridgeConfig, msgId: string): Promise<void> {
  const persona = settings.persona;
  if (!persona) {
    return;
  }

  const events = await listDeliveryEvents(settings);
  const matching = events.filter((event) => event.msgId === msgId);
  for (const event of matching) {
    const month = mailboxMonth(event.sentAt);
    const archive = path.join(eventsDir(settings, persona), "archive", month);
    await mkdir(archive, { recursive: true });
    const raw = JSON.parse(await readFile(event.path, "utf8")) as Record<string, unknown>;
    raw.acked_at = new Date().toISOString();
    const archivedPath = path.join(archive, path.basename(event.path));
    await writeAtomicJson(archivedPath, raw);
    await unlink(event.path).catch(() => undefined);
  }
}

async function ackSeenEvents(
  settings: MailboxBridgeConfig,
  events: DeliveryEvent[],
  seen: SeenState,
): Promise<void> {
  for (const event of events) {
    if (seen.messages[event.msgId]) {
      await ackDeliveryEvents(settings, event.msgId);
    }
  }
}

async function recordDeliveryReceipt(
  settings: MailboxBridgeConfig,
  message: MailboxMessage,
  status: string,
  messagePath: string,
  failureReason?: string,
): Promise<void> {
  const dir = receiptsDir(settings, message.to);
  await mkdir(dir, { recursive: true });
  await writeAtomicJson(path.join(dir, `${message.msgId}.json`), {
    msg_id: message.msgId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    sent_at: message.sentAt,
    status,
    delivered_by: BRIDGE_DELIVERED_BY,
    recorded_at: new Date().toISOString(),
    message_path: messagePath,
    failure_reason: failureReason,
  });
}

async function loadSeenState(file: string): Promise<SeenState> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as SeenState;
    if (parsed && typeof parsed === "object" && parsed.messages && typeof parsed.messages === "object") {
      return parsed;
    }
  } catch {
    // Missing or corrupt state should not block mailbox recovery.
  }
  return { messages: {} };
}

async function saveSeenState(file: string, state: SeenState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomicJson(file, state);
}

function mailboxSeenStatePath(workspace: string, persona: string): string {
  const safePersona = persona.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(workspace, ".telecodex", `mailbox_seen_${safePersona}.json`);
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, file);
}

async function writeAtomicJson(file: string, payload: unknown): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function currentMailboxTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mailboxPath(settings: MailboxBridgeConfig, ...segments: string[]): string {
  const root = mailboxRoot(settings);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Mailbox path escaped the mailbox root");
  }
  return target;
}

function safeOptionalSegment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !isSafeSegment(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function safeSegment(value: string): string {
  assertSafeSegment(value, "mailbox path segment");
  return value;
}

function assertSafeSegment(value: string, name: string): void {
  if (!isSafeSegment(value)) {
    throw new Error(`${name} must be a safe single path segment`);
  }
}

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT_RE.test(value);
}

function optionalMailboxField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "null" || normalized === "none") {
    return undefined;
  }

  return trimmed;
}

function parseMailboxTimestampMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(trimmed);
  const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(trimmed);
  if (!compact && !isoUtc) {
    return undefined;
  }
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function mailboxMonth(value: string): string {
  const parsed = parseMailboxTimestampMs(value);
  if (parsed !== undefined) {
    const date = new Date(parsed);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const isoMonth = /^(\d{4})-(\d{2})/.exec(value);
  if (isoMonth) {
    return `${isoMonth[1]}-${isoMonth[2]}`;
  }

  const compactMonth = /^(\d{4})(\d{2})/.exec(value);
  if (compactMonth) {
    return `${compactMonth[1]}-${compactMonth[2]}`;
  }

  return new Date().toISOString().slice(0, 7);
}

function stripMailboxTitle(message: MailboxMessage): string {
  const lines = message.body.split(/\r?\n/);
  if (lines[0]?.trim() === `# ${message.subject}`) {
    return lines.slice(1).join("\n").trim();
  }
  return message.body;
}
