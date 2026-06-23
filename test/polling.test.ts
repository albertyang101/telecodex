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
});
