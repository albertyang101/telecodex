import { afterEach, describe, expect, it, vi } from "vitest";

import { stopPollingWithTimeout, waitForIdleWithTimeout } from "../src/shutdown.js";

describe("stopPollingWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for bot idle before completing shutdown drain", async () => {
    const released = deferred<void>();
    const bot = {
      waitForIdle: vi.fn(async () => {
        await released.promise;
      }),
    };
    const logger = { error: vi.fn() };
    let returned = false;

    const drained = waitForIdleWithTimeout(bot, 4000, logger).then(() => {
      returned = true;
    });
    await Promise.resolve();

    expect(bot.waitForIdle).toHaveBeenCalledTimes(1);
    expect(returned).toBe(false);

    released.resolve();
    await drained;

    expect(returned).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns after the timeout when runner polling does not finish", async () => {
    vi.useFakeTimers();
    const polling = {
      stop: vi.fn(async () => {
        await new Promise(() => {});
      }),
    };
    const logger = { error: vi.fn() };

    const stopped = stopPollingWithTimeout(polling, 4000, logger);
    await Promise.resolve();

    expect(polling.stop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000);
    await stopped;

    expect(logger.error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Timed out stopping Telegram polling after 4000ms",
    );
  });

  it("waits for runner polling to stop before returning", async () => {
    const released = deferred<void>();
    const polling = {
      stop: vi.fn(async () => {
        await released.promise;
      }),
    };
    const logger = { error: vi.fn() };
    let returned = false;

    const stopped = stopPollingWithTimeout(polling, 4000, logger).then(() => {
      returned = true;
    });
    await Promise.resolve();

    expect(returned).toBe(false);
    released.resolve();
    await stopped;

    expect(returned).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
