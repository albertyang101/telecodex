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
  onHandle?: (handle: RunnerHandle) => void;
  shouldStop?: () => boolean;
};

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

  while (!options.shouldStop?.()) {
    const handle = await startTelegramPolling(bot, options);
    options.onHandle?.(handle);
    const task = handle.task();
    if (!task) {
      return;
    }

    try {
      await task;
      return;
    } catch (error) {
      if (options.shouldStop?.()) {
        return;
      }

      if (isTelegramConflictError(error) && conflictRestartAttempts < maxConflictRestartAttempts) {
        conflictRestartAttempts += 1;
        console.warn(
          `Polling conflict (attempt ${conflictRestartAttempts}/${maxConflictRestartAttempts}); retrying in ${
            conflictRestartDelayMs / 1000
          }s...`,
        );
        await delay(conflictRestartDelayMs);
        continue;
      }

      throw error;
    }
  }
}

function isTelegramConflictError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "error_code" in error && error.error_code === 409) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("409") || message.includes("Conflict");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
