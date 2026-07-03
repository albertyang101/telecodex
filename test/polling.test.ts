import { describe, expect, it, vi } from "vitest";

const runnerMock = vi.hoisted(() => ({
  handle: {
    isRunning: vi.fn(() => true),
    size: vi.fn(() => 0),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    task: vi.fn(() => new Promise<void>(() => undefined)),
  },
  run: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  run: runnerMock.run,
}));

import { startTelegramPolling } from "../src/polling.js";
import { runTelegramPollingWithRetry } from "../src/polling.js";

describe("startTelegramPolling", () => {
  beforeEach(() => {
    runnerMock.run.mockReset();
    runnerMock.handle.isRunning.mockClear();
    runnerMock.handle.size.mockClear();
    runnerMock.handle.start.mockClear();
    runnerMock.handle.stop.mockClear();
    runnerMock.handle.task.mockReset();
  });

  it("uses grammY runner without dropping queued updates during normal restarts", async () => {
    runnerMock.run.mockReturnValue(runnerMock.handle);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
      start: vi.fn(),
    };

    const handle = await startTelegramPolling(bot as any, { concurrency: 8 });

    expect(bot.api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false });
    expect(runnerMock.run).toHaveBeenCalledWith(bot, {
      runner: {
        fetch: { timeout: 30 },
        maxRetryTime: 15_000,
        retryInterval: 3_000,
      },
      sink: { concurrency: 8 },
    });
    expect(bot.start).not.toHaveBeenCalled();
    expect(handle).toBe(runnerMock.handle);
  });

  it("can explicitly drop queued updates for one-off clean startup", async () => {
    runnerMock.run.mockReturnValue(runnerMock.handle);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
    };

    await startTelegramPolling(bot as any, { dropPendingUpdates: true });

    expect(bot.api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: true });
  });

  it("retries short-lived Telegram 409 conflicts during polling startup", async () => {
    const firstHandle = {
      ...runnerMock.handle,
      task: vi.fn(() => Promise.reject({ error_code: 409, description: "Conflict: terminated by other getUpdates request" })),
    };
    const secondHandle = {
      ...runnerMock.handle,
      task: vi.fn(() => Promise.resolve()),
    };
    runnerMock.run.mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
    };

    await runTelegramPollingWithRetry(bot as any, {
      conflictRestartDelayMs: 0,
      maxConflictRestartAttempts: 1,
    });

    expect(runnerMock.run).toHaveBeenCalledTimes(2);
    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(2);
    expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(1, { drop_pending_updates: false });
    expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(2, { drop_pending_updates: false });
  });

  it("only drops queued updates once when explicit clean startup retries after a Telegram conflict", async () => {
    const firstHandle = {
      ...runnerMock.handle,
      task: vi.fn(() => Promise.reject({ error_code: 409, description: "Conflict: terminated by other getUpdates request" })),
    };
    const secondHandle = {
      ...runnerMock.handle,
      task: vi.fn(() => Promise.resolve()),
    };
    runnerMock.run.mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
    };

    await runTelegramPollingWithRetry(bot as any, {
      conflictRestartDelayMs: 0,
      dropPendingUpdates: true,
      maxConflictRestartAttempts: 1,
    });

    expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(1, { drop_pending_updates: true });
    expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(2, { drop_pending_updates: false });
  });

  it("fails after five Telegram 409 conflicts by default so launchd can restart a stuck loser", async () => {
    const conflictHandles = Array.from({ length: 6 }, () => ({
      ...runnerMock.handle,
      task: vi.fn(() =>
        Promise.reject({ error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
      ),
    }));
    for (const handle of conflictHandles) {
      runnerMock.run.mockReturnValueOnce(handle);
    }
    runnerMock.run.mockReturnValueOnce({
      ...runnerMock.handle,
      task: vi.fn(() => Promise.resolve()),
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
    };

    await expect(runTelegramPollingWithRetry(bot as any, {
      conflictRestartDelayMs: 0,
    })).rejects.toMatchObject({ error_code: 409 });

    expect(runnerMock.run).toHaveBeenCalledTimes(6);
    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(6);
  });

  it("keeps retrying Telegram 409 conflicts when explicitly configured as unbounded", async () => {
    const conflictHandles = Array.from({ length: 6 }, () => ({
      ...runnerMock.handle,
      task: vi.fn(() =>
        Promise.reject({ error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
      ),
    }));
    const recoveredHandle = {
      ...runnerMock.handle,
      task: vi.fn(() => Promise.resolve()),
    };
    for (const handle of conflictHandles) {
      runnerMock.run.mockReturnValueOnce(handle);
    }
    runnerMock.run.mockReturnValueOnce(recoveredHandle);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
      },
    };

    await runTelegramPollingWithRetry(bot as any, {
      conflictRestartDelayMs: 0,
      maxConflictRestartAttempts: Number.POSITIVE_INFINITY,
    });

    expect(runnerMock.run).toHaveBeenCalledTimes(7);
    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(7);
  });

  it("restarts polling when Telegram updates stay pending while the runner is alive", async () => {
    vi.useFakeTimers();
    try {
      const staleHandle = {
        ...runnerMock.handle,
        isRunning: vi.fn(() => true),
        size: vi.fn(() => 0),
        stop: vi.fn(async () => undefined),
        task: vi.fn(() => new Promise<void>(() => undefined)),
      };
      const recoveredHandle = {
        ...runnerMock.handle,
        task: vi.fn(() => Promise.resolve()),
      };
      runnerMock.run.mockReturnValueOnce(staleHandle).mockReturnValueOnce(recoveredHandle);
      const bot = {
        api: {
          deleteWebhook: vi.fn(async () => true),
          getWebhookInfo: vi
            .fn()
            .mockResolvedValueOnce({ pending_update_count: 3 })
            .mockResolvedValueOnce({ pending_update_count: 3 }),
        },
      };
      const runPromise = runTelegramPollingWithRetry(bot as any, {
        pendingUpdateWatchdogIntervalMs: 10,
        pendingUpdateWatchdogStaleMs: 10,
      });

      await vi.advanceTimersByTimeAsync(20);
      await runPromise;

      expect(staleHandle.stop).toHaveBeenCalledTimes(1);
      expect(runnerMock.run).toHaveBeenCalledTimes(2);
      expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(1, { drop_pending_updates: false });
      expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(2, { drop_pending_updates: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not drop queued updates when the pending-update watchdog restarts after an explicit clean startup", async () => {
    vi.useFakeTimers();
    try {
      const staleHandle = {
        ...runnerMock.handle,
        isRunning: vi.fn(() => true),
        size: vi.fn(() => 0),
        stop: vi.fn(async () => undefined),
        task: vi.fn(() => new Promise<void>(() => undefined)),
      };
      const recoveredHandle = {
        ...runnerMock.handle,
        task: vi.fn(() => Promise.resolve()),
      };
      runnerMock.run.mockReturnValueOnce(staleHandle).mockReturnValueOnce(recoveredHandle);
      const bot = {
        api: {
          deleteWebhook: vi.fn(async () => true),
          getWebhookInfo: vi
            .fn()
            .mockResolvedValueOnce({ pending_update_count: 3 })
            .mockResolvedValueOnce({ pending_update_count: 3 }),
        },
      };
      const runPromise = runTelegramPollingWithRetry(bot as any, {
        dropPendingUpdates: true,
        pendingUpdateWatchdogIntervalMs: 10,
        pendingUpdateWatchdogStaleMs: 10,
      });

      await vi.advanceTimersByTimeAsync(20);
      await runPromise;

      expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(1, { drop_pending_updates: true });
      expect(bot.api.deleteWebhook).toHaveBeenNthCalledWith(2, { drop_pending_updates: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart polling while the runner is still processing updates", async () => {
    vi.useFakeTimers();
    try {
      const busyHandle = {
        ...runnerMock.handle,
        isRunning: vi.fn(() => true),
        size: vi.fn(() => 1),
        stop: vi.fn(async () => undefined),
        task: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 25))),
      };
      runnerMock.run.mockReturnValueOnce(busyHandle);
      const bot = {
        api: {
          deleteWebhook: vi.fn(async () => true),
          getWebhookInfo: vi
            .fn()
            .mockResolvedValueOnce({ pending_update_count: 3 })
            .mockResolvedValueOnce({ pending_update_count: 3 }),
        },
      };
      const runPromise = runTelegramPollingWithRetry(bot as any, {
        pendingUpdateWatchdogIntervalMs: 10,
        pendingUpdateWatchdogStaleMs: 10,
      });

      await vi.advanceTimersByTimeAsync(25);
      await runPromise;

      expect(busyHandle.stop).not.toHaveBeenCalled();
      expect(runnerMock.run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
