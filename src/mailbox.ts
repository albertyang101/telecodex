import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodexPromptInput, CodexSessionCallbacks, CodexSessionService } from "./codex-session.js";
import type { MailboxBridgeConfig, TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { stripVisiblePromptGuardEcho, withDispatcherDisciplineGuard } from "./prompt-guard.js";
import type { SessionRegistry } from "./session-registry.js";

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

interface SeenState {
  messages: Record<string, { processedAt: string; from: string; path: string; status?: string }>;
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
  const unseenMessages = (await listInboxMessages(settings)).filter((msg) => !seen.messages[msg.msgId]);
  const historicalMessages = unseenMessages.filter((msg) => !isAfterMinSentAt(settings, msg));
  const historicalSkipped = await markHistoricalSkipped(settings, statePath, seen, historicalMessages);
  const unreadMessages = unseenMessages.filter((msg) => isAfterMinSentAt(settings, msg));
  const eventBackedMessages = eventMsgIds.size > 0
    ? unreadMessages.filter((msg) => eventMsgIds.has(msg.msgId))
    : unreadMessages;
  const messages = (eventBackedMessages.length > 0 ? eventBackedMessages : unreadMessages)
    .slice(0, settings.maxMessagesPerTick);

  if (messages.length === 0) {
    await ackSeenEvents(settings, events, seen);
    return { processed: 0, replied: 0, skipped: historicalSkipped };
  }

  const session = settings.launchProfileId
    ? await registry.getOrCreate(contextKey, { launchProfileId: settings.launchProfileId })
    : await registry.getOrCreate(contextKey);
  ensureMailboxSessionLaunchProfile(session, settings.allowUnsafeLaunchProfile);
  let processed = 0;
  let replied = 0;
  let skipped = historicalSkipped;

  for (const message of messages) {
    if (session.isProcessing()) {
      skipped += 1;
      break;
    }

    if (!session.hasActiveThread()) {
      await session.newThread();
    }

    let finalText: string;
    try {
      finalText = await promptMailboxMessage(
        session,
        message,
        settings.promptTimeoutMs,
        abortGraceMs,
      );
    } catch (error) {
      if (!(error instanceof MailboxPromptTimeoutError)) {
        throw error;
      }
      await quarantineTimedOutMailboxMessage(settings, statePath, seen, message);
      error.startAbortGrace(onFatalRecovery);
      registry.updateMetadata(contextKey, session);
      skipped += 1;
      break;
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
    };
    await saveSeenState(statePath, seen);
    await unlink(message.path).catch(() => undefined);
    registry.updateMetadata(contextKey, session);
    processed += 1;
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
): Promise<string> {
  let accumulatedText = "";
  let completedAgentText = "";
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
    onAgentEnd: () => undefined,
  };

  const promptPromise = session.prompt(
    withDispatcherDisciplineGuard(renderCodexMailboxPrompt(message), session.getInfo()),
    callbacks,
  );
  await awaitMailboxPrompt(session, promptPromise, timeoutMs, abortGraceMs);
  return stripVisiblePromptGuardEcho(completedAgentText || accumulatedText);
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
