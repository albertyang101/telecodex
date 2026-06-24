import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { AbortController as TelegramAbortController, type AbortSignal as TelegramAbortSignal } from "abort-controller";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
} from "./codex-session.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import { getThread } from "./codex-state.js";
import type { TeleCodexConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { codexCapacityRetryDelayMs, friendlyErrorText } from "./error-messages.js";
import {
  type EnqueueForegroundTextPromptResult,
  type ForegroundTextPromptEntry,
  type ForegroundTextPromptClaim,
  ForegroundTextPromptQueue,
} from "./foreground-prompt-queue.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { stripVisiblePromptGuardEcho, withTelegramReplyStyleGuard } from "./prompt-guard.js";
import { SessionRegistry } from "./session-registry.js";
import { getTranscriptionBackendStatus, transcribeAudio } from "./voice.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const DURABLE_FOREGROUND_CLAIM_HEARTBEAT_MS = 10_000;
const DURABLE_FOREGROUND_REPLAY_FAILURE_RETRY_MS = 60_000;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const DEFAULT_TELEGRAM_API_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

type TelegramChatId = number | string;
type TelegramChatAction = "typing" | "upload_photo" | "upload_document";
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

type BusyState = {
  processing: boolean;
  switching: boolean;
  transcribing: number;
  activeSession?: CodexSessionService;
  abortRequested: boolean;
  supersededByFollowUp: boolean;
};

type QueuedPrompt = {
  ctx: Context;
  chatId: TelegramChatId;
  session: CodexSessionService;
  status: "pending" | "ready" | "skipped";
  input?: CodexPromptInput;
  durableTextPromptIds?: string[];
  durableHeartbeat?: ReturnType<typeof setInterval>;
  receiptReaction?: Promise<void>;
  reactionTargets?: PromptReaction[];
  afterPrompt?: () => Promise<void>;
};

type PromptReaction = {
  ctx: Context;
  receiptReaction?: Promise<void>;
};

type PendingTextCoalesce = {
  contextKey: TelegramContextKey;
  ctx: Context;
  chatId: TelegramChatId;
  session: CodexSessionService;
  texts: string[];
  durableTextPromptIds: string[];
  reactionTargets: PromptReaction[];
  timer: ReturnType<typeof setTimeout>;
  heartbeat: ReturnType<typeof setInterval>;
};

type DurableForegroundTextPrompt = Pick<EnqueueForegroundTextPromptResult, "id" | "inserted"> & {
  claimedForScheduling: boolean;
  claimToken?: string;
};

type ClaimedForegroundTextReplay = {
  entry: ForegroundTextPromptEntry;
  durableTextPrompt: DurableForegroundTextPrompt;
};

export function formatTelegramIngressAuditLine(ctx: Context, authorized: boolean): string {
  const updateId = (ctx.update as { update_id?: number } | undefined)?.update_id ?? "unknown";
  const updateType = ctx.message ? "message" : ctx.callbackQuery ? "callback_query" : "unknown";
  const fromId = ctx.from?.id ?? "unknown";
  const chatId = ctx.chat?.id ?? "unknown";
  const chatType = ctx.chat?.type ?? "unknown";
  const messageId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id ?? "unknown";
  return [
    `Telegram ingress update_id=${updateId}`,
    `type=${updateType}`,
    `from_id=${fromId}`,
    `chat_id=${chatId}`,
    `chat_type=${chatType}`,
    `message_id=${messageId}`,
    `authorized=${authorized ? "yes" : "no"}`,
  ].join(" ");
}

class CodexTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex turn timed out after ${timeoutMs}ms`);
    this.name = "CodexTurnTimeoutError";
  }
}

class CodexTurnAbortGraceError extends Error {
  constructor(timeoutMs: number, abortGraceMs: number) {
    super(`Codex turn remained active after timeout abort grace (${timeoutMs}ms + ${abortGraceMs}ms)`);
    this.name = "CodexTurnAbortGraceError";
  }
}

export type BotRecoveryOptions = {
  onFatalRecovery?: (error: Error) => void;
};

const SOURCE_REQUEST_RE =
  /((?:show|include|with|provide|send|list|cite|add|attach|give)\s+(?:me\s+)?(?:the\s+)?(?:visible\s+)?(?:sources?|references?|citations?|sauces?|links?|urls?)|official\s+(?:site|url|link)|source\s*block|(?:给|列|带|附|发|贴|提供|保留|加上|展示|显示).{0,12}(?:引用|来源|出处|参考资料|链接|网址|官网)|(?:引用|来源|出处|参考资料|链接|网址|官网).{0,12}(?:发我|给我|列出|带上|附上|也要|保留|贴出来))/i;
const SOURCE_PRESERVE_RE =
  /((?:不要省略|不要漏|别忘了|记得|请给|发我|给我|带上|附上|列出).{0,12}(?:sources?|references?|citations?|links?|urls?|引用|来源|出处|参考资料|链接|网址|官网)|(?:sources?|references?|citations?|links?|urls?|引用|来源|出处|参考资料|链接|网址|官网).{0,12}(?:发我|给我|不要省略|不要漏|别忘了|带上|附上|列出))/i;
const SOURCE_DIRECT_NEED_RE =
  /(?:^|[\s，。！？；：,.!?;:])(?:我)?需要(?:一下|下)?(?:引用|来源|出处|参考资料|链接|网址|官网)(?:[\s，。！？；：,.!?;:]|$)/i;
const SOURCE_NEGATION_RE =
  /((?:no|without|do\s+not|don't|dont|never|skip|omit)\s+(?:visible\s+)?(?:sources?|references?|citations?|sauces?|links?)|(?:不要|别|不用|无需|不需要|不要发|别发|不要给|别给|不要带|别带|不要加|别加).{0,8}(?:sources?|references?|citations?|sauces?|links?|source\s*block|引用|来源|出处|参考资料|链接|链接来源)|(?:sources?|references?|citations?|sauces?|links?|引用|来源|出处|参考资料|链接).{0,8}(?:不要|别|不用|无需|不需要))/i;
const SOURCE_HEADING_LINE_RE =
  /^\s*(?:[-*•]\s*)?(?:sources?|references?|citations?|source\s*block|来源|引用|出处|参考资料|资料来源|sauces?)\s*[:：]\s*$/i;
const SOURCE_HEADING_WITH_URL_RE =
  /^\s*(?:[-*•]\s*)?(?:sources?|references?|citations?|source\s*block|来源|引用|出处|参考资料|资料来源|sauces?)\s*[:：]\s*.*(?:https?:\/\/|www\.|\[[^\]]+\]\(https?:\/\/).*/i;
const SOURCE_HEADING_WITH_TEXT_RE =
  /^\s*(?:[-*•]\s*)?(?:sources?|references?|citations?|source\s*block|来源|引用|出处|参考资料|资料来源|sauces?)\s*[:：]\s*\S.*$/i;
const URL_IN_LINE_RE = /(?:https?:\/\/|www\.|\[[^\]]+\]\(https?:\/\/)/i;
const URL_ONLY_LINE_RE = /^\s*(?:[-*•]\s*)?(?:https?:\/\/|www\.|\[[^\]]+\]\(https?:\/\/)[^\n]*$/i;

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

function userRequestedSources(userText: string): boolean {
  return (
    SOURCE_DIRECT_NEED_RE.test(userText) ||
    SOURCE_PRESERVE_RE.test(userText) ||
    (SOURCE_REQUEST_RE.test(userText) && !SOURCE_NEGATION_RE.test(userText))
  );
}

function visibleUserText(input: CodexPromptInput): string {
  if (typeof input === "string") {
    return input;
  }

  return input.text ?? "";
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateStamp(now = new Date()): string {
  return [
    now.getFullYear(),
    padTwoDigits(now.getMonth() + 1),
    padTwoDigits(now.getDate()),
  ].join("-");
}

function todaySessionFile(root: string, now = new Date()): string {
  return path.join(root, `${localDateStamp(now)}.md`);
}

function turnTimestamp(now = new Date()): string {
  return [
    padTwoDigits(now.getHours()),
    padTwoDigits(now.getMinutes()),
    padTwoDigits(now.getSeconds()),
  ].join(":");
}

function sanitizeTurnText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function turnMetadata(ctx: Context, contextKey: TelegramContextKey, session: CodexSessionService): string {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  const ids = chatId !== undefined && messageId !== undefined ? `${chatId}:${messageId}` : "unknown";
  const threadId = session.getInfo().threadId;
  return [
    `message_id=${ids}`,
    `context_key=${contextKey}`,
    threadId ? `thread_id=${threadId}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join("; ");
}

async function appendMemoryTranscriptTurn(
  config: TeleCodexConfig,
  ctx: Context,
  contextKey: TelegramContextKey,
  session: CodexSessionService,
  tag: "user-raw" | "bot-raw",
  text: string,
): Promise<void> {
  const root = config.memoryTranscriptRoot;
  const body = sanitizeTurnText(text);
  if (!root || !body) {
    return;
  }

  await mkdir(root, { recursive: true });
  const file = todaySessionFile(root);
  const block = [
    `## ${turnTimestamp()} [${tag}]`,
    `<!-- ${turnMetadata(ctx, contextKey, session)} -->`,
    body,
    "",
  ].join("\n");
  await appendFile(file, block, "utf8");
}

async function waitForCodexPrompt(
  session: CodexSessionService,
  promptPromise: Promise<void>,
  timeoutMs: number | undefined,
  options?: {
    abortGraceMs?: number;
    onSettledAfterTimeout?: () => Promise<void>;
    onFatalRecovery?: (error: Error) => void;
    shouldAbortOnTimeout?: () => boolean;
  },
): Promise<void> {
  if (!timeoutMs) {
    await promptPromise;
    return;
  }

  let timedOut = false;
  let notifiedPostTimeoutSettle = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortGraceTimeout: ReturnType<typeof setTimeout> | undefined;
  const abortGraceMs = options?.abortGraceMs ?? timeoutMs;
  const onFatalRecovery = options?.onFatalRecovery;
  const notifyPromptSettledAfterTimeout = (error?: unknown): void => {
    if (!timedOut || notifiedPostTimeoutSettle) {
      return;
    }
    notifiedPostTimeoutSettle = true;
    if (abortGraceTimeout) {
      clearTimeout(abortGraceTimeout);
      abortGraceTimeout = undefined;
    }

    if (error && !isAbortLikeError(error)) {
      console.error("Codex prompt error after timeout abort:", formatError(error));
    }

    if (!options?.onSettledAfterTimeout) {
      return;
    }

    void options.onSettledAfterTimeout().catch((callbackError) => {
      console.error("Failed to drain queued prompts after timeout abort:", formatError(callbackError));
    });
  };
  const observedPromptPromise = promptPromise.catch((error) => {
    if (timedOut) {
      notifyPromptSettledAfterTimeout(error);
      return;
    }
    throw error;
  }).then(() => {
    notifyPromptSettledAfterTimeout();
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      if (options?.shouldAbortOnTimeout?.() ?? true) {
        void session.abort().catch((error) => {
          console.error("Failed to abort timed-out Codex turn:", formatError(error));
        });
      }
      if (abortGraceMs && onFatalRecovery) {
        abortGraceTimeout = setTimeout(() => {
          if (notifiedPostTimeoutSettle || !session.isProcessing()) {
            return;
          }
          onFatalRecovery(new CodexTurnAbortGraceError(timeoutMs, abortGraceMs));
        }, abortGraceMs);
      }
      reject(new CodexTurnTimeoutError(timeoutMs));
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

function stripVisibleSourceFooter(userText: string, replyText: string): string {
  if (!replyText || userRequestedSources(userText)) {
    return replyText;
  }

  const trimmed = replyText.trimEnd();
  const lines = trimmed.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]?.trim()) {
    last -= 1;
  }
  if (last < 0) {
    return "";
  }

  const trailingParagraphStart = findTrailingParagraphStart(lines, last);
  const sourceHeadingInTrailingParagraph = findSourceHeadingInRange(lines, trailingParagraphStart, last);
  if (sourceHeadingInTrailingParagraph !== undefined) {
    return lines.slice(0, sourceHeadingInTrailingParagraph).join("\n").trimEnd();
  }

  let cursor = last;
  let sawUrl = false;
  while (cursor >= 0) {
    const line = lines[cursor] ?? "";
    if (!line.trim()) {
      cursor -= 1;
      continue;
    }
    if (!URL_IN_LINE_RE.test(line)) {
      break;
    }
    sawUrl = true;
    cursor -= 1;
  }

  if (!sawUrl) {
    return trimmed;
  }

  let heading = cursor;
  while (heading >= 0 && !lines[heading]?.trim()) {
    heading -= 1;
  }

  if (heading >= 0 && SOURCE_HEADING_LINE_RE.test(lines[heading] ?? "")) {
    return lines.slice(0, heading).join("\n").trimEnd();
  }

  const tailStart = cursor + 1;
  const tailLines = lines.slice(tailStart).filter((line) => line.trim());
  if (tailLines.length > 0 && tailLines.every((line) => URL_ONLY_LINE_RE.test(line))) {
    return lines.slice(0, tailStart).join("\n").trimEnd();
  }

  return trimmed;
}

function findTrailingParagraphStart(lines: string[], last: number): number {
  let start = last;
  while (start > 0 && lines[start - 1]?.trim()) {
    start -= 1;
  }
  return start;
}

function findSourceHeadingInRange(lines: string[], start: number, end: number): number | undefined {
  for (let index = start; index <= end; index += 1) {
    const line = lines[index] ?? "";
    if (SOURCE_HEADING_LINE_RE.test(line) || SOURCE_HEADING_WITH_TEXT_RE.test(line) || SOURCE_HEADING_WITH_URL_RE.test(line)) {
      return index;
    }
  }
  return undefined;
}

export function createBot(
  config: TeleCodexConfig,
  registry: SessionRegistry,
  recoveryOptions: BotRecoveryOptions = {},
): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const foregroundTextQueue = new ForegroundTextPromptQueue(config.workspace);

  const contextBusy = new Map<TelegramContextKey, BusyState>();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const pendingPromptQueues = new Map<TelegramContextKey, QueuedPrompt[]>();
  const drainingPromptQueues = new Set<TelegramContextKey>();
  const pendingTextCoalesces = new Map<string, PendingTextCoalesce>();
  const scheduledDurableForegroundTextPromptIds = new Set<string>();
  const durableForegroundTextPromptClaimTokens = new Map<string, string>();
  const durableForegroundTextPromptScheduleHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
  const durableForegroundTextPromptReleasePromises = new Map<string, Promise<void>>();
  const activeTelegramChatActions = new Set<string>();
  let foregroundReplayScheduling: Promise<void> | undefined;
  let durableForegroundRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let durableForegroundRetryTimerDueAt: number | undefined;

  registry.onRemove((key) => {
    const queuedPrompts = pendingPromptQueues.get(key) ?? [];
    for (const queuedPrompt of queuedPrompts) {
      stopQueuedPromptHeartbeat(queuedPrompt);
    }
    const queuedDurableTextPromptIds = queuedPrompts.flatMap((item) => item.durableTextPromptIds ?? []);
    if (queuedDurableTextPromptIds.length > 0) {
      void releaseDurableForegroundTextPromptIds(
        queuedDurableTextPromptIds,
        "pending",
        "Failed to preserve durable queued foreground text prompts after context removal:",
      );
    }
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    lastPromptInput.delete(key);
    pendingPromptQueues.delete(key);
    drainingPromptQueues.delete(key);
    for (const [coalesceKey, pending] of pendingTextCoalesces) {
      if (pending.contextKey === key) {
        clearTimeout(pending.timer);
        clearInterval(pending.heartbeat);
        pendingTextCoalesces.delete(coalesceKey);
        void releaseDurableForegroundTextPromptIds(
          pending.durableTextPromptIds,
          "pending",
          "Failed to preserve durable coalesced foreground text prompts after context removal:",
        );
        void failPromptReactions(pending.reactionTargets).catch((error) => {
          console.error("Failed to clear coalesced Telegram text reactions after context removal:", error);
        });
      }
    }
  });

  const getBusyState = (contextKey: TelegramContextKey): BusyState => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = {
        processing: false,
        switching: false,
        transcribing: 0,
        abortRequested: false,
        supersededByFollowUp: false,
      };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const hasPendingTextCoalesce = (contextKey: TelegramContextKey): boolean => {
    for (const pending of pendingTextCoalesces.values()) {
      if (pending.contextKey === contextKey) {
        return true;
      }
    }
    return false;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(
      state?.processing ||
        state?.switching ||
        state?.transcribing ||
        session?.isProcessing() ||
        hasPendingTextCoalesce(contextKey),
    );
  };

  const hasQueuedFollowUp = (contextKey: TelegramContextKey): boolean => {
    return (
      (pendingPromptQueues.get(contextKey)?.some((item) => item.status !== "skipped") ?? false) ||
      hasPendingTextCoalesce(contextKey)
    );
  };

  const interruptActivePrompt = (contextKey: TelegramContextKey): void => {
    const busyState = getBusyState(contextKey);
    const activeSession = busyState.activeSession ?? registry.get(contextKey);
    if (busyState.abortRequested || (!busyState.processing && !activeSession?.isProcessing())) {
      return;
    }

    busyState.abortRequested = true;
    busyState.supersededByFollowUp = true;
    void activeSession?.abort().catch((error) => {
      console.error("Failed to abort active Codex turn after Telegram follow-up:", formatError(error));
    });
  };

  const waitForForegroundReplayScheduling = async (): Promise<void> => {
    if (!foregroundReplayScheduling) {
      return;
    }
    await foregroundReplayScheduling;
  };

  const scheduleDurableForegroundRetryReplay = (nextAttemptAt: number): void => {
    if (
      durableForegroundRetryTimer &&
      durableForegroundRetryTimerDueAt !== undefined &&
      durableForegroundRetryTimerDueAt <= nextAttemptAt
    ) {
      return;
    }

    if (durableForegroundRetryTimer) {
      clearTimeout(durableForegroundRetryTimer);
    }

    durableForegroundRetryTimerDueAt = nextAttemptAt;
    const delayMs = Math.max(0, nextAttemptAt - Date.now());
    durableForegroundRetryTimer = setTimeout(() => {
      durableForegroundRetryTimer = undefined;
      durableForegroundRetryTimerDueAt = undefined;
      void replayForegroundTextPrompts()
        .catch((error) => {
          console.error("Failed to replay retryable durable foreground text prompts:", formatError(error));
        })
        .finally(() => {
          void scheduleNextDurableForegroundRetryFromQueue().catch((error) => {
            console.error("Failed to schedule next durable foreground retry:", formatError(error));
          });
        });
    }, delayMs);
  };

  const scheduleNextDurableForegroundRetryFromQueue = async (): Promise<void> => {
    const now = Date.now();
    const nextAttemptAt = (await foregroundTextQueue.list())
      .filter((entry) => entry.status === "pending" && entry.nextAttemptAt !== undefined && entry.nextAttemptAt > now)
      .map((entry) => entry.nextAttemptAt!)
      .sort((left, right) => left - right)[0];

    if (nextAttemptAt !== undefined) {
      scheduleDurableForegroundRetryReplay(nextAttemptAt);
    }
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    await waitForForegroundReplayScheduling();
    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await withTelegramApiTimeout("Telegram editMessageReplyMarkup", (signal) =>
          bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard }, signal),
        );
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const rememberPromptInput = (contextKey: TelegramContextKey, input: CodexPromptInput): void => {
    if (typeof input === "string") {
      lastPromptInput.set(contextKey, input);
      return;
    }

    if (input.text) {
      lastPromptInput.set(contextKey, input.text);
    }
  };

  const startTranscribing = (contextKey: TelegramContextKey): (() => void) => {
    const busyState = getBusyState(contextKey);
    busyState.transcribing += 1;
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      busyState.transcribing = Math.max(0, busyState.transcribing - 1);
    };
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const completeReaction = async (ctx: Context, receiptReaction?: Promise<void>): Promise<void> => {
    if (receiptReaction) {
      void receiptReaction.finally(() => {
        void setReaction(ctx, "👍");
      }).catch(() => {});
    }
    void setReaction(ctx, "👍").catch(() => {});
  };

  const failReaction = async (ctx: Context, receiptReaction?: Promise<void>): Promise<void> => {
    if (receiptReaction) {
      void receiptReaction.finally(() => {
        void clearReaction(ctx);
      }).catch(() => {});
    }
    void clearReaction(ctx).catch(() => {});
  };

  const promptReactionTargets = (item: QueuedPrompt): PromptReaction[] => {
    return item.reactionTargets ?? [{ ctx: item.ctx, receiptReaction: item.receiptReaction }];
  };

  const durableForegroundTextPromptIdFor = (
    contextKey: TelegramContextKey,
    ctx: Context,
  ): string | undefined => {
    const messageId = ctx.message?.message_id;
    if (messageId === undefined) {
      return undefined;
    }
    return `${contextKey}:${messageId}`;
  };

  const isDurableForegroundTextPromptScheduled = (id: string): boolean => {
    return scheduledDurableForegroundTextPromptIds.has(id);
  };

  const markDurableForegroundTextPromptIdsScheduled = (ids: string[] | undefined): void => {
    for (const id of ids ?? []) {
      scheduledDurableForegroundTextPromptIds.add(id);
    }
  };

  const stopDurableForegroundTextPromptScheduleHeartbeat = (id: string): void => {
    const heartbeat = durableForegroundTextPromptScheduleHeartbeats.get(id);
    if (!heartbeat) {
      return;
    }
    clearInterval(heartbeat);
    durableForegroundTextPromptScheduleHeartbeats.delete(id);
  };

  const markDurableForegroundTextPromptIdsUnscheduled = (ids: string[] | undefined): void => {
    for (const id of ids ?? []) {
      scheduledDurableForegroundTextPromptIds.delete(id);
      durableForegroundTextPromptClaimTokens.delete(id);
      stopDurableForegroundTextPromptScheduleHeartbeat(id);
    }
  };

  const durableForegroundTextPromptClaimsFor = (ids: string[] | undefined): ForegroundTextPromptClaim[] => {
    const claims: ForegroundTextPromptClaim[] = [];
    for (const id of ids ?? []) {
      const claimToken = durableForegroundTextPromptClaimTokens.get(id);
      if (claimToken) {
        claims.push({ id, claimToken });
      }
    }
    return claims;
  };

  const startDurableForegroundTextPromptHeartbeat = (
    ids: string[] | undefined,
    errorMessage: string,
  ): ReturnType<typeof setInterval> | undefined => {
    const durableIds = ids?.filter((id, index, allIds) => allIds.indexOf(id) === index) ?? [];
    if (durableIds.length === 0) {
      return undefined;
    }

    return setInterval(() => {
      const claims = durableForegroundTextPromptClaimsFor(durableIds);
      if (claims.length === 0) {
        return;
      }
      void foregroundTextQueue.touchClaimedMany(claims).catch((error) => {
        console.error(errorMessage, formatError(error));
      });
    }, DURABLE_FOREGROUND_CLAIM_HEARTBEAT_MS);
  };

  const startDurableForegroundTextPromptScheduleHeartbeat = (id: string): void => {
    if (durableForegroundTextPromptScheduleHeartbeats.has(id)) {
      return;
    }
    const heartbeat = startDurableForegroundTextPromptHeartbeat(
      [id],
      "Failed to heartbeat scheduled durable foreground text prompt claim:",
    );
    if (heartbeat) {
      durableForegroundTextPromptScheduleHeartbeats.set(id, heartbeat);
    }
  };

  function stopQueuedPromptHeartbeat(item: QueuedPrompt): void {
    if (!item.durableHeartbeat) {
      return;
    }
    clearInterval(item.durableHeartbeat);
    item.durableHeartbeat = undefined;
  }

  const waitForDurableForegroundTextPromptRelease = async (id: string): Promise<void> => {
    await durableForegroundTextPromptReleasePromises.get(id);
  };

  const releaseDurableForegroundTextPromptIds = async (
    ids: string[] | undefined,
    action: "pending" | "remove",
    errorMessage: string,
    options: { nextAttemptAt?: number } = {},
  ): Promise<void> => {
    const durableIds = ids ?? [];
    if (durableIds.length === 0) {
      return;
    }

    const claims = durableForegroundTextPromptClaimsFor(durableIds);
    const releasePromise = Promise.resolve()
      .then(async () => {
        if (claims.length === 0) {
          return;
        }
        if (action === "pending") {
          await foregroundTextQueue.markPendingClaimedMany(claims, {
            nextAttemptAt: options.nextAttemptAt,
          });
        } else {
          await foregroundTextQueue.removeClaimedMany(claims);
        }
      })
      .catch((error) => {
        console.error(errorMessage, formatError(error));
      })
      .finally(() => {
        markDurableForegroundTextPromptIdsUnscheduled(durableIds);
        for (const id of durableIds) {
          if (durableForegroundTextPromptReleasePromises.get(id) === releasePromise) {
            durableForegroundTextPromptReleasePromises.delete(id);
          }
        }
      });

    for (const id of durableIds) {
      durableForegroundTextPromptReleasePromises.set(id, releasePromise);
    }

    await releasePromise;
  };

  const claimDurableForegroundTextPromptForScheduling = async (
    id: string,
    inserted: boolean,
  ): Promise<DurableForegroundTextPrompt> => {
    if (scheduledDurableForegroundTextPromptIds.has(id)) {
      return { id, inserted, claimedForScheduling: false };
    }

    const claimed = await foregroundTextQueue.claim(id);
    if (!claimed) {
      return { id, inserted, claimedForScheduling: false };
    }

    markDurableForegroundTextPromptIdsScheduled([id]);
    if (claimed.claimToken) {
      durableForegroundTextPromptClaimTokens.set(id, claimed.claimToken);
      startDurableForegroundTextPromptScheduleHeartbeat(id);
    }
    return { id, inserted, claimedForScheduling: true, claimToken: claimed.claimToken };
  };

  const completePromptReactions = async (targets: PromptReaction[]): Promise<void> => {
    await Promise.all(targets.map((target) => completeReaction(target.ctx, target.receiptReaction)));
  };

  const failPromptReactions = async (targets: PromptReaction[]): Promise<void> => {
    await Promise.all(targets.map((target) => failReaction(target.ctx, target.receiptReaction)));
  };

  const sendRepeatingChatAction = async <T>(
    chatId: TelegramChatId,
    action: TelegramChatAction,
    task: () => Promise<T>,
    messageThreadId?: number,
  ): Promise<T> => {
    const interval = setInterval(() => {
      sendChatActionBestEffort(chatId, action, messageThreadId);
    }, TYPING_INTERVAL_MS);

    sendChatActionBestEffort(chatId, action, messageThreadId);

    try {
      return await task();
    } finally {
      clearInterval(interval);
    }
  };

  const sendChatActionBestEffort = (
    chatId: TelegramChatId,
    action: TelegramChatAction,
    messageThreadId?: number,
  ): void => {
    const key = `${chatId}:${messageThreadId ?? ""}:${action}`;
    if (activeTelegramChatActions.has(key)) {
      return;
    }
    activeTelegramChatActions.add(key);
    const options = messageThreadId ? { message_thread_id: messageThreadId } : {};
    void withTelegramApiTimeout("Telegram sendChatAction", (signal) =>
      bot.api.sendChatAction(chatId, action, options, signal),
    )
      .catch((error) => {
        console.warn(`Failed to send Telegram chat action: ${friendlyErrorText(error)}`);
      })
      .finally(() => {
        activeTelegramChatActions.delete(key);
      });
  };

  const enqueuePrompt = (
    contextKey: TelegramContextKey,
    item: QueuedPrompt,
  ): QueuedPrompt => {
    const queue = pendingPromptQueues.get(contextKey) ?? [];
    item.durableHeartbeat ??= startDurableForegroundTextPromptHeartbeat(
      item.durableTextPromptIds,
      "Failed to heartbeat queued durable foreground text prompt claim:",
    );
    queue.push(item);
    pendingPromptQueues.set(contextKey, queue);
    return item;
  };

  const drainQueuedPrompts = async (contextKey: TelegramContextKey): Promise<void> => {
    if (drainingPromptQueues.has(contextKey) || isBusy(contextKey)) {
      return;
    }

    drainingPromptQueues.add(contextKey);
    try {
      while (!isBusy(contextKey)) {
        const queue = pendingPromptQueues.get(contextKey);
        const next = queue?.[0];
        if (!next) {
          pendingPromptQueues.delete(contextKey);
          return;
        }

        if (next.status === "pending") {
          return;
        }

        queue.shift();
        if (queue && queue.length === 0) {
          pendingPromptQueues.delete(contextKey);
        }
        stopQueuedPromptHeartbeat(next);

        if (next.status === "skipped") {
          await failPromptReactions(promptReactionTargets(next));
          if (next.afterPrompt) {
            await next.afterPrompt();
          }
          continue;
        }

        if (!next.input) {
          if (next.afterPrompt) {
            await next.afterPrompt();
          }
          continue;
        }

        try {
          await handleUserPrompt(
            next.ctx,
            contextKey,
            next.chatId,
            next.session,
            next.input,
            next.durableTextPromptIds,
          );
          await completePromptReactions(promptReactionTargets(next));
        } catch {
          await failPromptReactions(promptReactionTargets(next));
        } finally {
          if (next.afterPrompt) {
            await next.afterPrompt();
          }
        }
      }
    } finally {
      drainingPromptQueues.delete(contextKey);
    }
  };

  const runOrQueuePrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    input: CodexPromptInput,
    options?: { reactionAlreadySet?: boolean; reactionTargets?: PromptReaction[]; durableTextPromptIds?: string[] },
  ): Promise<void> => {
    rememberPromptInput(contextKey, input);
    markDurableForegroundTextPromptIdsScheduled(options?.durableTextPromptIds);
    const receiptReaction = options?.reactionAlreadySet ? undefined : setReaction(ctx, "👀");
    const reactionTargets = options?.reactionTargets ?? [{ ctx, receiptReaction }];

    const hasQueuedPrompts = (pendingPromptQueues.get(contextKey)?.length ?? 0) > 0;
    if (isBusy(contextKey) || hasQueuedPrompts) {
      enqueuePrompt(contextKey, {
        ctx,
        chatId,
        session,
        status: "ready",
        input,
        durableTextPromptIds: options?.durableTextPromptIds,
        receiptReaction,
        reactionTargets,
      });
      interruptActivePrompt(contextKey);
      await drainQueuedPrompts(contextKey);
      return;
    }

    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, input, options?.durableTextPromptIds);
      await completePromptReactions(reactionTargets);
    } catch {
      await failPromptReactions(reactionTargets);
    }
  };

  const textCoalesceKey = (contextKey: TelegramContextKey, ctx: Context): string => {
    return `${contextKey}\u0000${ctx.from?.id ?? "unknown"}`;
  };

  const formatCoalescedTextInput = (texts: string[]): string => {
    if (texts.length === 1) {
      return texts[0] ?? "";
    }

    return [
      "Albert sent these Telegram messages consecutively. Treat them as one user turn, in order:",
      "",
      ...texts.map((text, index) => `[${index + 1}]\n${text}`),
    ].join("\n\n");
  };

  const startTextCoalesceHeartbeat = (key: string): ReturnType<typeof setInterval> => {
    return setInterval(() => {
      const pending = pendingTextCoalesces.get(key);
      if (!pending) {
        return;
      }
      const claims = durableForegroundTextPromptClaimsFor(pending.durableTextPromptIds);
      if (claims.length === 0) {
        return;
      }
      void foregroundTextQueue.touchClaimedMany(claims).catch((error) => {
        console.error("Failed to heartbeat durable coalesced foreground text prompt claim:", formatError(error));
      });
    }, DURABLE_FOREGROUND_CLAIM_HEARTBEAT_MS);
  };

  const persistForegroundTextPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    text: string,
  ): Promise<DurableForegroundTextPrompt> => {
    const knownId = durableForegroundTextPromptIdFor(contextKey, ctx);
    if (knownId && isDurableForegroundTextPromptScheduled(knownId)) {
      return { id: knownId, inserted: false, claimedForScheduling: false };
    }

    const result = await foregroundTextQueue.enqueue({
      contextKey,
      chatId,
      fromId: ctx.from?.id,
      messageId: ctx.message?.message_id,
      messageThreadId: ctx.message?.message_thread_id,
      text,
    });
    return await claimDurableForegroundTextPromptForScheduling(result.id, result.inserted);
  };

  const flushTextCoalescedPrompt = async (key: string): Promise<void> => {
    const pending = pendingTextCoalesces.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    clearInterval(pending.heartbeat);
    pendingTextCoalesces.delete(key);
    const input = formatCoalescedTextInput(pending.texts);
    await runOrQueuePrompt(pending.ctx, pending.contextKey, pending.chatId, pending.session, input, {
      reactionAlreadySet: true,
      reactionTargets: pending.reactionTargets,
      durableTextPromptIds: pending.durableTextPromptIds,
    });
  };

  const flushTextCoalesceForSender = async (contextKey: TelegramContextKey, ctx: Context): Promise<void> => {
    await flushTextCoalescedPrompt(textCoalesceKey(contextKey, ctx));
  };

  const flushTextCoalescesForContext = async (contextKey: TelegramContextKey): Promise<void> => {
    const flushes: Promise<void>[] = [];
    for (const [coalesceKey, pending] of [...pendingTextCoalesces]) {
      if (pending.contextKey === contextKey) {
        flushes.push(flushTextCoalescedPrompt(coalesceKey));
      }
    }
    await Promise.all(flushes);
  };

  const cancelPendingTextCoalescesForContext = async (contextKey: TelegramContextKey): Promise<void> => {
    const reactionTargets: PromptReaction[] = [];
    const durableTextPromptIds: string[] = [];
    for (const [coalesceKey, pending] of pendingTextCoalesces) {
      if (pending.contextKey !== contextKey) {
        continue;
      }

      clearTimeout(pending.timer);
      clearInterval(pending.heartbeat);
      pendingTextCoalesces.delete(coalesceKey);
      reactionTargets.push(...pending.reactionTargets);
      durableTextPromptIds.push(...pending.durableTextPromptIds);
    }

    if (reactionTargets.length > 0) {
      await failPromptReactions(reactionTargets);
    }

    if (durableTextPromptIds.length > 0) {
      await releaseDurableForegroundTextPromptIds(
        durableTextPromptIds,
        "remove",
        "Failed to remove durable coalesced foreground text prompts after cancellation:",
      );
    }
  };

  const runOrCoalesceTextPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userText: string,
    durableTextPrompt: DurableForegroundTextPrompt,
  ): Promise<void> => {
    if (!durableTextPrompt.claimedForScheduling) {
      return;
    }

    const windowMs = config.telegramTextCoalesceMs;
    if (windowMs <= 0) {
      await runOrQueuePrompt(ctx, contextKey, chatId, session, userText, {
        durableTextPromptIds: [durableTextPrompt.id],
      });
      return;
    }

    const key = textCoalesceKey(contextKey, ctx);
    const receiptReaction = setReaction(ctx, "👀");
    const existing = pendingTextCoalesces.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      clearInterval(existing.heartbeat);
      existing.ctx = ctx;
      existing.chatId = chatId;
      existing.session = session;
      existing.texts.push(userText);
      existing.durableTextPromptIds.push(durableTextPrompt.id);
      markDurableForegroundTextPromptIdsScheduled([durableTextPrompt.id]);
      existing.reactionTargets.push({ ctx, receiptReaction });
      existing.timer = setTimeout(() => {
        void flushTextCoalescedPrompt(key).catch((error) => {
          console.error("Failed to flush coalesced Telegram text prompt:", formatError(error));
        });
      }, windowMs);
      existing.heartbeat = startTextCoalesceHeartbeat(key);
      interruptActivePrompt(contextKey);
      return;
    }

    const pending: PendingTextCoalesce = {
      contextKey,
      ctx,
      chatId,
      session,
      texts: [userText],
      durableTextPromptIds: [durableTextPrompt.id],
      reactionTargets: [{ ctx, receiptReaction }],
      timer: setTimeout(() => {
        void flushTextCoalescedPrompt(key).catch((error) => {
          console.error("Failed to flush coalesced Telegram text prompt:", formatError(error));
        });
      }, windowMs),
      heartbeat: startTextCoalesceHeartbeat(key),
    };
    pendingTextCoalesces.set(key, pending);
    markDurableForegroundTextPromptIdsScheduled([durableTextPrompt.id]);
    interruptActivePrompt(contextKey);
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    durableTextPromptIds?: string[],
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;
    busyState.activeSession = session;
    busyState.abortRequested = false;
    busyState.supersededByFollowUp = false;

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const streamAgentResponses = config.streamAgentResponses;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let completedAgentText = "";
    let hasCompletedAgentText = false;
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let finalizePromise: Promise<string> | undefined;
    const userVisibleText = visibleUserText(userInput);
    const durableIds = durableTextPromptIds?.filter((id, index, ids) => ids.indexOf(id) === index) ?? [];
    const durableClaims = durableForegroundTextPromptClaimsFor(durableIds);
    let durableTextPromptHandled = durableIds.length === 0;
    let retryDurableTextPromptDelayMs: number | undefined;
    const durableClaimHeartbeat =
      durableClaims.length > 0
        ? setInterval(() => {
            void foregroundTextQueue.touchClaimedMany(durableClaims).catch((error) => {
              console.error("Failed to heartbeat durable foreground text prompt claim:", formatError(error));
            });
          }, DURABLE_FOREGROUND_CLAIM_HEARTBEAT_MS)
        : undefined;

    const typingInterval = setInterval(() => {
      sendChatActionBestEffort(chatId, "typing", messageThreadId);
    }, TYPING_INTERVAL_MS);
    sendChatActionBestEffort(chatId, "typing", messageThreadId);

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const renderPreview = (): RenderedChunk => {
      const visibleText = stripVisiblePromptGuardEcho(accumulatedText.trim());
      const previewText = buildStreamingPreview(stripVisibleSourceFooter(userVisibleText, visibleText));
      return renderMarkdownChunkWithinLimit(previewText);
    };

    const buildFinalResponseText = (text: string): string => {
      const visibleText = stripVisiblePromptGuardEcho(text.trim());
      const trimmedText = stripVisibleSourceFooter(userVisibleText, visibleText);
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const finalResponseSourceText = (): string => {
      if (!streamAgentResponses && hasCompletedAgentText) {
        return completedAgentText;
      }
      return accumulatedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const preview = renderPreview();
        const message = await sendTextMessage(bot.api, chatId, preview.text, {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = preview.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
        return;
      }

      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        return;
      }

      isFlushing = true;
      try {
        await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
          parseMode: nextText.parseMode,
          fallbackText: nextText.fallbackText,
          replyMarkup: abortKeyboard,
        });
        lastRenderedText = nextText.text;
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await withTelegramApiTimeout("Telegram editMessageReplyMarkup", (signal) =>
          bot.api.editMessageReplyMarkup(chatId, responseMessageId!, {
            reply_markup: new InlineKeyboard(),
          }, signal),
        );
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const removeInterruptedResponseMessage = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      const interruptedMessageId = responseMessageId;
      try {
        await withTelegramApiTimeout("Telegram deleteMessage", (signal) =>
          bot.api.deleteMessage(chatId, interruptedMessageId, signal),
        );
        responseMessageId = undefined;
        lastRenderedText = "";
      } catch (deleteError) {
        const replacement = renderMarkdownChunkWithinLimit("已收到后续消息，正在按最新内容处理。");
        try {
          await safeEditMessage(bot, chatId, interruptedMessageId, replacement.text, {
            parseMode: replacement.parseMode,
            fallbackText: replacement.fallbackText,
            replyMarkup: new InlineKeyboard(),
          });
          lastRenderedText = replacement.text;
        } catch (editError) {
          console.error("Failed to clear interrupted Telegram response message:", formatError(deleteError));
          console.error("Failed to replace interrupted Telegram response message:", formatError(editError));
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const finalizeResponse = async (): Promise<string> => {
      if (finalized) {
        return "";
      }
      finalized = true;

      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(finalResponseSourceText());
      if (!finalText) {
        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return plainText;
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
      return finalText;
    };

    const ensureFinalized = (): Promise<string> => {
      if (!finalizePromise) {
        finalizePromise = finalizeResponse();
      }
      return finalizePromise;
    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        if (!streamAgentResponses) {
          return;
        }

        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onAgentMessage: (text: string) => {
        completedAgentText = text;
        hasCompletedAgentText = true;
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onAgentEnd: () => {
        void ensureFinalized().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex is not authenticated.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "Use /login to start authentication, or set CODEX_API_KEY on the host.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex is not authenticated.",
              "",
              authStatus.detail,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
          },
        );
        durableTextPromptHandled = true;
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        durableTextPromptHandled = true;
        return;
      }

      await appendMemoryTranscriptTurn(config, ctx, contextKey, session, "user-raw", userVisibleText).catch((error) => {
        console.error("Failed to append memory user turn:", error instanceof Error ? error.message : String(error));
      });

      await waitForCodexPrompt(
        session,
        session.prompt(withTelegramReplyStyleGuard(userInput, session.getInfo()), callbacks),
        config.codexTurnTimeoutMs,
        {
          abortGraceMs: config.codexTurnAbortGraceMs,
          onSettledAfterTimeout: async () => {
            getBusyState(contextKey).abortRequested = false;
            await drainQueuedPrompts(contextKey);
          },
          onFatalRecovery: recoveryOptions.onFatalRecovery,
          shouldAbortOnTimeout: () => {
            const currentBusyState = getBusyState(contextKey);
            if (currentBusyState.abortRequested) {
              return false;
            }
            currentBusyState.abortRequested = true;
            return true;
          },
        },
      );
      updateSessionMetadata(contextKey, session);
      const finalVisibleText = await ensureFinalized();
      await appendMemoryTranscriptTurn(
        config,
        ctx,
        contextKey,
        session,
        "bot-raw",
        finalVisibleText,
      ).catch((error) => {
        console.error("Failed to append memory bot turn:", error instanceof Error ? error.message : String(error));
      });
      durableTextPromptHandled = true;
    } catch (error) {
      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
        try {
          const finalVisibleText = await ensureFinalized();
          await appendMemoryTranscriptTurn(
            config,
            ctx,
            contextKey,
            session,
            "bot-raw",
            finalVisibleText,
          ).catch((appendError) => {
            console.error(
              "Failed to append memory bot turn:",
              appendError instanceof Error ? appendError.message : String(appendError),
            );
          });
          durableTextPromptHandled = true;
        } catch (finalizeError) {
          console.error("Finalized Telegram response did not complete after Codex prompt error:", formatError(finalizeError));
        }
      } else {
        const suppressInterruptedFailure =
          (busyState.supersededByFollowUp || hasQueuedFollowUp(contextKey)) &&
          (isAbortLikeError(error) || error instanceof CodexTurnTimeoutError);
        if (suppressInterruptedFailure) {
          durableTextPromptHandled = true;
          await removeInterruptedResponseMessage();
          console.error("Codex prompt interrupted by newer Telegram input:", formatError(error));
          return;
        }

        finalized = true;

        retryDurableTextPromptDelayMs = codexCapacityRetryDelayMs(error);
        const shouldPreserveDurablePrompt =
          error instanceof CodexTurnTimeoutError || retryDurableTextPromptDelayMs !== undefined;
        durableTextPromptHandled = !shouldPreserveDurablePrompt;
        const failureSourceText = streamAgentResponses ? accumulatedText : completedAgentText;
        const combinedText = buildFinalResponseText(renderPromptFailure(failureSourceText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks);
          await appendMemoryTranscriptTurn(config, ctx, contextKey, session, "bot-raw", combinedText).catch(
            (appendError) => {
              console.error(
                "Failed to append memory bot turn:",
                appendError instanceof Error ? appendError.message : String(appendError),
              );
            },
          );
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      if (durableClaimHeartbeat) {
        clearInterval(durableClaimHeartbeat);
      }
      if (durableIds.length > 0) {
        if (durableTextPromptHandled) {
          await releaseDurableForegroundTextPromptIds(
            durableIds,
            "remove",
            "Failed to remove durable foreground text prompt:",
          );
        } else {
          await releaseDurableForegroundTextPromptIds(
            durableIds,
            "pending",
            "Failed to mark durable foreground text prompt pending:",
            retryDurableTextPromptDelayMs !== undefined
              ? { nextAttemptAt: Date.now() + retryDurableTextPromptDelayMs }
              : undefined,
          );
          if (retryDurableTextPromptDelayMs !== undefined) {
            scheduleDurableForegroundRetryReplay(Date.now() + retryDurableTextPromptDelayMs);
          }
        }
      }
      busyState.processing = false;
      busyState.activeSession = undefined;
      if (!session.isProcessing()) {
        busyState.abortRequested = false;
      }
      busyState.supersededByFollowUp = false;
      await drainQueuedPrompts(contextKey);
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    sendChatActionBestEffort(chatId, "upload_document", messageThreadId);

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await withTelegramApiTimeout("Telegram sendDocument", (signal) =>
          ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          }, signal),
        );
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    const authorized = Boolean(fromId && config.telegramAllowedUserIdSet.has(fromId));
    console.log(formatTelegramIngressAuditLine(ctx, authorized));
    if (!authorized) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    await waitForForegroundReplayScheduling();

    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    await waitForForegroundReplayScheduling();

    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    let status: Awaited<ReturnType<typeof getTranscriptionBackendStatus>> | null = null;
    let statusError: unknown;
    try {
      status = await getTranscriptionBackendStatus();
    } catch (error) {
      statusError = error;
    }

    if (statusError) {
      await safeReply(
        ctx,
        `<b>Voice transcription configuration error:</b>\n${escapeHTML(friendlyErrorText(statusError))}`,
        {
          fallbackText: `Voice transcription configuration error:\n${friendlyErrorText(statusError)}`,
        },
      );
      return;
    }

    const backends = status?.available ?? [];

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Set <code>VOICE_TRANSCRIPTION_BACKEND=qwen</code> with <code>QWEN_ASR_SOCKET</code>, install <code>parakeet-coreml</code> + ffmpeg, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription is separate from CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Set VOICE_TRANSCRIPTION_BACKEND=qwen with QWEN_ASR_SOCKET, install parakeet-coreml + ffmpeg, or set OPENAI_API_KEY.",
            "Note: voice transcription is separate from CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    const active = status?.active ?? `${status?.requested ?? "unknown"} (not available)`;
    const requested = status?.requested ?? "unknown";
    await safeReply(
      ctx,
      [
        `<b>Active backend:</b> <code>${escapeHTML(active)}</code>`,
        `<b>Requested:</b> <code>${escapeHTML(requested)}</code>`,
        `<b>Available:</b> <code>${escapeHTML(joined)}</code>`,
      ].join("\n"),
      {
        fallbackText: [
          `Active backend: ${active}`,
          `Requested: ${requested}`,
          `Available: ${joined}`,
        ].join("\n"),
      },
    );
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      try {
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
        const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
        const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Select workspace for new thread:</b>", {
      fallbackText: "Select workspace for new thread:",
      replyMarkup: keyboard,
    });
  });

  bot.command("abort", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      await cancelPendingTextCoalescesForContext(contextKey);
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    const receiptReaction = setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await completeReaction(ctx, receiptReaction);
    } catch {
      await failReaction(ctx, receiptReaction);
    }
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Select a profile for new or reattached threads:",
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Select a profile for new or reattached threads:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread handed back to Codex CLI.",
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread handed back to Codex CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    if (!getThread(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info)}`;
        const plain = `Switched thread.\n\n${renderSessionInfoPlain(info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("No recent threads found."), {
        fallbackText: "No recent threads found.",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");

    await safeReply(ctx, `<b>Recent threads</b> (${orderedSessions.length}):\nTap to switch.`, {
      fallbackText: `Recent threads (${orderedSessions.length}):\nTap to switch.`,
      replyMarkup: keyboard,
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new threads:`
      : "<b>Reasoning effort:</b> not set (model default)\n\nSelect for new threads:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    await waitForForegroundReplayScheduling();

    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await cancelPendingTextCoalescesForContext(contextKey);
    await session.abort();
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Launch set to ${selectedProfile.label}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>danger-full-access confirmed for new or reattached threads.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "danger-full-access confirmed for new or reattached threads.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new threads.`;
      const plainText = `Model set to ${model} — applies to new threads.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as ModelReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /effort again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort set to <code>${escapeHTML(effort)}</code> — applies to new threads.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort set to ${effort} — applies to new threads.`,
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    let durableTextPrompt = await persistForegroundTextPrompt(ctx, contextKey, ctx.chat.id, userText);
    if (!durableTextPrompt.claimedForScheduling) {
      await waitForForegroundReplayScheduling();
      await waitForDurableForegroundTextPromptRelease(durableTextPrompt.id);
      durableTextPrompt = await claimDurableForegroundTextPromptForScheduling(
        durableTextPrompt.id,
        durableTextPrompt.inserted,
      );
      if (!durableTextPrompt.claimedForScheduling) {
        return;
      }
    } else {
      await waitForForegroundReplayScheduling();
    }
    try {
      const session = await registry.getOrCreate(contextKey);
      await runOrCoalesceTextPrompt(ctx, contextKey, ctx.chat.id, session, userText, durableTextPrompt);
    } catch (error) {
      await releaseDurableForegroundTextPromptIds(
        [durableTextPrompt.id],
        "pending",
        "Failed to release durable foreground text prompt after scheduling failure:",
      );
      throw error;
    }
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    await waitForForegroundReplayScheduling();

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    await flushTextCoalescesForContext(contextKey);

    const receiptReaction = setReaction(ctx, "👀");
    const queuedPrompt = enqueuePrompt(contextKey, { ctx, chatId, session, status: "pending", receiptReaction });
    const stopTranscribing = startTranscribing(contextKey);
    let tempFilePath: string | undefined;
    const messageThreadId = parseContextKey(contextKey).messageThreadId;

    try {
      const result = await sendRepeatingChatAction(chatId, "typing", async () => {
        tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);
        return await transcribeAudio(tempFilePath);
      }, messageThreadId);

      const transcript = result.text.trim();
      if (!transcript) {
        queuedPrompt.status = "skipped";
        void safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        }).catch(() => {});
        return;
      }

      queuedPrompt.status = "ready";
      queuedPrompt.input = transcript;
      rememberPromptInput(contextKey, transcript);
    } catch (error) {
      queuedPrompt.status = "skipped";
      const note = "Note: voice transcription is separate from CODEX_API_KEY.";
      void safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      }).catch(() => {});
      return;
    } finally {
      stopTranscribing();
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
      await drainQueuedPrompts(contextKey);
    }
  });

  bot.on("message:photo", async (ctx) => {
    await waitForForegroundReplayScheduling();

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    await flushTextCoalescesForContext(contextKey);

    const receiptReaction = setReaction(ctx, "👀");
    const queuedPrompt = enqueuePrompt(contextKey, { ctx, chatId, session, status: "pending", receiptReaction });
    const stopTranscribing = startTranscribing(contextKey);
    let tempFilePath: string | undefined;

    try {
      sendChatActionBestEffort(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      queuedPrompt.status = "skipped";
      void safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      }).catch(() => {});
      return;
    } finally {
      stopTranscribing();
      await drainQueuedPrompts(contextKey);
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
    }
    rememberPromptInput(contextKey, promptInput);
    queuedPrompt.status = "ready";
    queuedPrompt.input = promptInput;
    queuedPrompt.afterPrompt = async () => {
      await unlink(tempFilePath).catch(() => {});
    };
    await drainQueuedPrompts(contextKey);
  });

  bot.on("message:document", async (ctx) => {
    await waitForForegroundReplayScheduling();

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    await flushTextCoalescesForContext(contextKey);

    const receiptReaction = setReaction(ctx, "👀");
    const queuedPrompt = enqueuePrompt(contextKey, { ctx, chatId, session, status: "pending", receiptReaction });
    const stopTranscribing = startTranscribing(contextKey);
    let tempFilePath: string | undefined;

    try {
      sendChatActionBestEffort(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      queuedPrompt.status = "skipped";
      void safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      }).catch(() => {});
      return;
    } finally {
      stopTranscribing();
      await drainQueuedPrompts(contextKey);
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      queuedPrompt.status = "skipped";
      void safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      }).catch(() => {});
      await drainQueuedPrompts(contextKey);
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    void safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    }).catch(() => {});

    // Keep typing visible during the gap between staging and prompt execution.
    sendChatActionBestEffort(chatId, "typing");

    const outDir = outboxPath(workspace, turnId);
    try {
      await ensureOutDir(outDir);
    } catch (error) {
      queuedPrompt.status = "skipped";
      void safeReply(ctx, `<b>Failed to prepare output folder:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to prepare output folder: ${friendlyErrorText(error)}`,
      }).catch(() => {});
      await cleanupInbox(workspace, turnId).catch(() => {});
      await drainQueuedPrompts(contextKey);
      return;
    }

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
    }
    rememberPromptInput(contextKey, promptInput);

    queuedPrompt.status = "ready";
    queuedPrompt.input = promptInput;
    queuedPrompt.afterPrompt = async () => {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", artifactError);
      } finally {
        await cleanupInbox(workspace, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    };
    await drainQueuedPrompts(contextKey);
  });

  const canCoalesceForegroundTextReplay = (
    previous: ForegroundTextPromptEntry,
    next: ForegroundTextPromptEntry,
  ): boolean => {
    if (config.telegramTextCoalesceMs <= 0) {
      return false;
    }
    return (
      previous.contextKey === next.contextKey &&
      previous.chatId === next.chatId &&
      previous.fromId !== undefined &&
      previous.fromId === next.fromId &&
      next.createdAt - previous.createdAt <= config.telegramTextCoalesceMs
    );
  };

  const groupClaimedForegroundTextReplays = (
    items: ClaimedForegroundTextReplay[],
  ): ClaimedForegroundTextReplay[][] => {
    const openGroupsByBucket = new Map<string, ClaimedForegroundTextReplay[]>();
    const openBucketsByContext = new Map<string, Set<string>>();
    const allGroups: ClaimedForegroundTextReplay[][] = [];
    for (const item of items) {
      const bucketKey = `${item.entry.contextKey}\u0000${item.entry.fromId ?? "unknown"}`;
      const contextOpenBuckets = openBucketsByContext.get(item.entry.contextKey) ?? new Set<string>();
      if (!openBucketsByContext.has(item.entry.contextKey)) {
        openBucketsByContext.set(item.entry.contextKey, contextOpenBuckets);
      }

      for (const openBucketKey of contextOpenBuckets) {
        if (openBucketKey !== bucketKey) {
          openGroupsByBucket.delete(openBucketKey);
        }
      }
      contextOpenBuckets.clear();
      contextOpenBuckets.add(bucketKey);

      const lastGroup = openGroupsByBucket.get(bucketKey);
      const lastItem = lastGroup?.[lastGroup.length - 1];
      if (lastItem && canCoalesceForegroundTextReplay(lastItem.entry, item.entry)) {
        lastGroup.push(item);
      } else {
        const group = [item];
        openGroupsByBucket.set(bucketKey, group);
        allGroups.push(group);
      }
    }
    return allGroups;
  };

  const replayForegroundTextPrompts = async (): Promise<void> => {
    const claimedReplays: ClaimedForegroundTextReplay[] = [];
    const enqueuedReplayDurableTextPromptIds = new Set<string>();
    const contextsToDrain = new Set<TelegramContextKey>();

    try {
      const entries = await foregroundTextQueue.list();
      for (const entry of entries) {
        if (entry.fromId === undefined || !config.telegramAllowedUserIdSet.has(entry.fromId)) {
          await foregroundTextQueue.remove(entry.id);
          continue;
        }

        const durableTextPrompt = await claimDurableForegroundTextPromptForScheduling(entry.id, false);
        if (!durableTextPrompt.claimedForScheduling) {
          continue;
        }

        claimedReplays.push({ entry, durableTextPrompt });
      }

      for (const group of groupClaimedForegroundTextReplays(claimedReplays)) {
        const first = group[0];
        const last = group[group.length - 1];
        if (!first || !last) {
          continue;
        }

        const durableTextPromptIds = group.map((item) => item.durableTextPrompt.id);
        const input = formatCoalescedTextInput(group.map((item) => item.entry.text));

        try {
          const session = await registry.getOrCreate(first.entry.contextKey);
          const replayCtx = {
            api: bot.api,
            chat: { id: last.entry.chatId, type: "private" },
            from: last.entry.fromId !== undefined ? { id: last.entry.fromId } : undefined,
            message: {
              message_id: last.entry.messageId ?? 0,
              text: input,
              ...(last.entry.messageThreadId ? { message_thread_id: last.entry.messageThreadId } : {}),
            },
          } as unknown as Context;
          enqueuePrompt(first.entry.contextKey, {
            ctx: replayCtx,
            chatId: last.entry.chatId,
            session,
            status: "ready",
            input,
            durableTextPromptIds,
            reactionTargets: [],
          });
          for (const durableTextPromptId of durableTextPromptIds) {
            enqueuedReplayDurableTextPromptIds.add(durableTextPromptId);
          }
          contextsToDrain.add(first.entry.contextKey);
        } catch (error) {
          await releaseDurableForegroundTextPromptIds(
            durableTextPromptIds,
            "pending",
            "Failed to release durable foreground text prompt after replay scheduling failure:",
          );
          scheduleDurableForegroundRetryReplay(Date.now() + DURABLE_FOREGROUND_REPLAY_FAILURE_RETRY_MS);
          console.error("Failed to schedule durable foreground text prompt replay:", formatError(error));
        }
      }

      for (const contextKey of contextsToDrain) {
        void drainQueuedPrompts(contextKey).catch((error) => {
          console.error("Failed to drain replayed durable foreground text prompts:", formatError(error));
        });
      }
    } catch (error) {
      const claimedButNotEnqueuedIds = claimedReplays
        .map((item) => item.durableTextPrompt.id)
        .filter((id) => !enqueuedReplayDurableTextPromptIds.has(id));
      await releaseDurableForegroundTextPromptIds(
        claimedButNotEnqueuedIds,
        "pending",
        "Failed to release claimed durable foreground text prompts after replay abort:",
      );
      if (claimedButNotEnqueuedIds.length > 0) {
        scheduleDurableForegroundRetryReplay(Date.now() + DURABLE_FOREGROUND_REPLAY_FAILURE_RETRY_MS);
      }
      throw error;
    } finally {
      await scheduleNextDurableForegroundRetryFromQueue();
    }
  };

  foregroundReplayScheduling = replayForegroundTextPrompts().catch((error) => {
    console.error("Failed to replay durable foreground text prompts:", formatError(error));
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "new", description: "Start a new thread" },
    { command: "session", description: "Current thread details" },
    { command: "sessions", description: "Browse & switch threads" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "abort", description: "Cancel current operation" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "model", description: "View & change model" },
    { command: "effort", description: "Set reasoning effort" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "attach", description: "Bind a Codex thread to this topic" },
    { command: "switch", description: "Switch to a thread by ID" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.nextModel ? `Next model: ${info.nextModel}` : undefined,
    info.nextReasoningEffort ? `Next reasoning effort: ${info.nextReasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.nextModel ? `<b>Next model:</b> <code>${escapeHTML(info.nextModel)}</code>` : undefined,
    info.nextReasoningEffort
      ? `<b>Next reasoning effort:</b> <code>${escapeHTML(info.nextReasoningEffort)}</code>`
      : undefined,
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await withTelegramApiTimeout("Telegram sendMessage", (signal) =>
      api.sendMessage(chatId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      }, signal),
    );
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await withTelegramApiTimeout("Telegram sendMessage fallback", (signal) =>
        api.sendMessage(chatId, options.fallbackText!, {
          ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
          reply_markup: options.replyMarkup,
        }, signal),
      );
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await withTelegramApiTimeout("Telegram editMessageText", (signal) =>
      bot.api.editMessageText(chatId, messageId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        reply_markup: options.replyMarkup,
      }, signal),
    );
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await withTelegramApiTimeout("Telegram editMessageText fallback", (signal) =>
        bot.api.editMessageText(chatId, messageId, options.fallbackText!, {
          reply_markup: options.replyMarkup,
        }, signal),
      );
      return;
    }

    throw error;
  }
}

async function withTelegramApiTimeout<T>(label: string, task: (signal: TelegramAbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = getPositiveIntegerEnv("TELEGRAM_API_CALL_TIMEOUT_MS", DEFAULT_TELEGRAM_API_CALL_TIMEOUT_MS);
  return await withTelegramAbortTimeout(timeoutMs, label, task);
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const timeoutMs = getPositiveIntegerEnv(
    "TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS",
    DEFAULT_TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS,
  );
  const file = await withTelegramAbortTimeout(timeoutMs, "Telegram file download", async (signal) => {
    return await api.getFile(fileId, signal);
  });

  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }
  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const buffer = await withAbortTimeout(timeoutMs, "Telegram file download", async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  });
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function withTelegramAbortTimeout<T>(
  timeoutMs: number,
  label: string,
  task: (signal: TelegramAbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new TelegramAbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(_accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return `⚠️ ${message}`;
}

function isAbortLikeError(error: unknown): boolean {
  return /AbortError|aborted|operation was aborted/i.test(formatError(error));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
