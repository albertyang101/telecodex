import { describe, expect, it, vi } from "vitest";

import { installFatalProcessHandlers } from "../src/process-lifecycle.js";

describe("installFatalProcessHandlers", () => {
  it("exits through launchd recovery after an unhandled rejection", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const bot = { stop: vi.fn() };
    const stopMailboxBridge = vi.fn();
    const registry = { disposeAll: vi.fn() };
    const logger = { error: vi.fn() };
    const exit = vi.fn();

    installFatalProcessHandlers({
      process: processLike,
      getBot: () => bot,
      getStopMailboxBridge: () => stopMailboxBridge,
      getRegistry: () => registry,
      logger,
      exit,
    });

    await handlers.get("unhandledRejection")?.(new Error("lost promise"));

    expect(logger.error.mock.calls[0]?.[0]).toContain("Fatal unhandledRejection: Error: lost promise");
    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(stopMailboxBridge).toHaveBeenCalledTimes(1);
    expect(registry.disposeAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("handles only the first fatal event", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const registry = { disposeAll: vi.fn() };
    const exit = vi.fn();

    installFatalProcessHandlers({
      process: processLike,
      getRegistry: () => registry,
      logger: { error: vi.fn() },
      exit,
    });

    await handlers.get("uncaughtException")?.(new Error("boom"));
    await handlers.get("unhandledRejection")?.(new Error("late"));

    expect(registry.disposeAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("fails loud when a fatal event happens while graceful shutdown is already running", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    installFatalProcessHandlers({
      process: processLike,
      logger,
      exit,
    });

    await handlers.get("uncaughtException")?.(new Error("during shutdown"));

    expect(logger.error.mock.calls[0]?.[0]).toContain("Fatal uncaughtException: Error: during shutdown");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs stack traces for fatal errors", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const logger = { error: vi.fn() };
    const error = new Error("boom");
    error.stack = "Error: boom\n    at fatal.test.ts:1:1";

    installFatalProcessHandlers({
      process: processLike,
      logger,
      exit: vi.fn(),
    });

    await handlers.get("uncaughtException")?.(error);

    expect(logger.error.mock.calls[0]?.[0]).toContain("Fatal uncaughtException: Error: boom");
    expect(logger.error.mock.calls[0]?.[0]).toContain("at fatal.test.ts");
  });

  it("waits for an async bot stop before exiting", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const stopReleased = deferred<void>();
    const bot = {
      stop: vi.fn(async () => {
        await stopReleased.promise;
      }),
    };
    const exit = vi.fn();

    const logger = { error: vi.fn() };
    installFatalProcessHandlers({
      process: processLike,
      getBot: () => bot,
      logger,
      exit,
    });

    const fatalPromise = handlers.get("unhandledRejection")?.(new Error("lost promise"));
    await Promise.resolve();

    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    stopReleased.resolve();
    await fatalPromise;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("bounds async bot stop so fatal recovery still exits", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const processLike = {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const bot = {
      stop: vi.fn(async () => {
        await new Promise(() => {});
      }),
    };
    const exit = vi.fn();
    const logger = { error: vi.fn() };

    installFatalProcessHandlers({
      process: processLike,
      getBot: () => bot,
      cleanupTimeoutMs: 5,
      logger,
      exit,
    });

    await handlers.get("uncaughtException")?.(new Error("stuck cleanup"));

    expect(logger.error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Timed out stopping Telegram bot after fatal error",
    );
    expect(exit).toHaveBeenCalledWith(1);
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
