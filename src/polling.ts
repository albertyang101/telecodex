import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Bot, Context } from "grammy";

export type TelegramPollingOptions = {
  dropPendingUpdates?: boolean;
  concurrency?: number;
  fetchTimeoutSeconds?: number;
  maxRetryTimeMs?: number;
  retryIntervalMs?: number;
};

export type TelegramPollingRetryOptions = TelegramPollingOptions & {
  maxConflictRestartAttempts?: number;
  conflictRestartDelayMs?: number;
  pendingUpdateWatchdogIntervalMs?: number;
  pendingUpdateWatchdogStaleMs?: number;
  pendingUpdateWatchdogMinPendingUpdates?: number;
  onHandle?: (handle: RunnerHandle) => void;
  shouldStop?: () => boolean;
  logger?: Pick<Console, "warn">;
};

const DEFAULT_PENDING_UPDATE_WATCHDOG_INTERVAL_MS = 10_000;
const DEFAULT_PENDING_UPDATE_WATCHDOG_STALE_MS = 60_000;
const DEFAULT_PENDING_UPDATE_WATCHDOG_MIN_UPDATES = 1;

export async function startTelegramPolling(
  bot: Bot<Context>,
  options: TelegramPollingOptions = {},
): Promise<RunnerHandle> {
  await bot.api.deleteWebhook({
    drop_pending_updates: options.dropPendingUpdates ?? false,
  });

  return run(bot, {
    runner: {
      fetch: { timeout: options.fetchTimeoutSeconds ?? 30 },
      maxRetryTime: options.maxRetryTimeMs ?? 15_000,
      retryInterval: options.retryIntervalMs ?? 3_000,
    },
    sink: { concurrency: options.concurrency ?? 8 },
  });
}

export async function runTelegramPollingWithRetry(
  bot: Bot<Context>,
  options: TelegramPollingRetryOptions = {},
): Promise<void> {
  const maxConflictRestartAttempts = options.maxConflictRestartAttempts ?? 5;
  const conflictRestartDelayMs = options.conflictRestartDelayMs ?? 3_000;
  let conflictRestartAttempts = 0;
  let pollingStartAttempts = 0;

  while (!options.shouldStop?.()) {
    const dropPendingUpdates = pollingStartAttempts === 0 ? options.dropPendingUpdates : false;
    pollingStartAttempts += 1;
    const handle = await startTelegramPolling(bot, {
      ...options,
      dropPendingUpdates,
    });
    options.onHandle?.(handle);
    const task = handle.task();
    if (!task) {
      return;
    }
    const watchdogAbort = new AbortController();
    const watchdogTask = watchForStalePendingUpdates(bot, handle, options, watchdogAbort.signal);

    try {
      await (watchdogTask ? Promise.race([task, watchdogTask]) : task);
      return;
    } catch (error) {
      if (options.shouldStop?.()) {
        return;
      }

      if (error instanceof PendingUpdatesStalledError) {
        console.warn(error.message);
        continue;
      }

      if (isTelegramConflictError(error) && conflictRestartAttempts < maxConflictRestartAttempts) {
        conflictRestartAttempts += 1;
        const limitLabel = Number.isFinite(maxConflictRestartAttempts) ? String(maxConflictRestartAttempts) : "unbounded";
        console.warn(
          `Polling conflict (attempt ${conflictRestartAttempts}/${limitLabel}); retrying in ${
            conflictRestartDelayMs / 1000
          }s...`,
        );
        await delay(conflictRestartDelayMs);
        continue;
      }

      throw error;
    } finally {
      watchdogAbort.abort();
    }
  }
}

class PendingUpdatesStalledError extends Error {
  constructor(pendingUpdates: number, staleMs: number) {
    super(
      `Telegram polling appears stalled: ${pendingUpdates} pending update(s) stayed unconsumed for ${staleMs}ms; restarting polling without dropping updates.`,
    );
    this.name = "PendingUpdatesStalledError";
  }
}

function watchForStalePendingUpdates(
  bot: Bot<Context>,
  handle: RunnerHandle,
  options: TelegramPollingRetryOptions,
  signal: AbortSignal,
): Promise<void> | undefined {
  const getWebhookInfo = bot.api.getWebhookInfo?.bind(bot.api);
  if (!getWebhookInfo) {
    return undefined;
  }

  const intervalMs = options.pendingUpdateWatchdogIntervalMs ?? DEFAULT_PENDING_UPDATE_WATCHDOG_INTERVAL_MS;
  const staleMs = options.pendingUpdateWatchdogStaleMs ?? DEFAULT_PENDING_UPDATE_WATCHDOG_STALE_MS;
  const minPendingUpdates = options.pendingUpdateWatchdogMinPendingUpdates ?? DEFAULT_PENDING_UPDATE_WATCHDOG_MIN_UPDATES;
  if (intervalMs <= 0 || staleMs <= 0 || minPendingUpdates <= 0) {
    return undefined;
  }

  const logger = options.logger ?? console;
  let firstStalePendingAt: number | undefined;
  let lastPendingUpdates = 0;

  return (async () => {
    while (!signal.aborted && !options.shouldStop?.()) {
      await delay(intervalMs, signal);
      if (signal.aborted || options.shouldStop?.()) {
        return;
      }

      let pendingUpdates = 0;
      try {
        const webhookInfo = await getWebhookInfo();
        pendingUpdates = webhookInfo.pending_update_count ?? 0;
      } catch (error) {
        logger.warn(`Failed to inspect Telegram pending updates: ${formatError(error)}`);
        firstStalePendingAt = undefined;
        lastPendingUpdates = 0;
        continue;
      }

      const runnerQueueSize = typeof handle.size === "function" ? handle.size() : 0;
      const runnerActive = typeof handle.isRunning === "function" ? handle.isRunning() : true;
      const looksStalled = runnerActive && runnerQueueSize === 0 && pendingUpdates >= minPendingUpdates;
      if (!looksStalled) {
        firstStalePendingAt = undefined;
        lastPendingUpdates = pendingUpdates;
        continue;
      }

      const now = Date.now();
      firstStalePendingAt ??= now;
      lastPendingUpdates = pendingUpdates;
      if (now - firstStalePendingAt < staleMs) {
        continue;
      }

      await handle.stop();
      throw new PendingUpdatesStalledError(lastPendingUpdates, now - firstStalePendingAt);
    }
  })();
}

function isTelegramConflictError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "error_code" in error && error.error_code === 409) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("409") || message.includes("Conflict");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
