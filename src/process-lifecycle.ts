type FatalEvent = "unhandledRejection" | "uncaughtException";

type ProcessLike = {
  once(event: FatalEvent, listener: (...args: unknown[]) => unknown): void;
};

type StoppableBot = {
  stop(): void | Promise<void>;
};

type DisposableRegistry = {
  disposeAll(): void;
};

type Logger = {
  error(message: string): void;
};

const DEFAULT_FATAL_CLEANUP_TIMEOUT_MS = 2_000;

export type FatalProcessHandlerOptions = {
  process?: ProcessLike;
  getStopTelegramPolling?: () => (() => void | Promise<void>) | undefined;
  getBot?: () => StoppableBot | undefined;
  getStopMailboxBridge?: () => (() => void) | undefined;
  getRegistry?: () => DisposableRegistry | undefined;
  cleanupTimeoutMs?: number;
  logger?: Logger;
  exit?: (code: number) => void;
};

export function installFatalProcessHandlers(options: FatalProcessHandlerOptions = {}): void {
  const processLike = options.process ?? process;
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_FATAL_CLEANUP_TIMEOUT_MS;
  let handlingFatal = false;

  const handleFatal = async (kind: FatalEvent, error: unknown): Promise<void> => {
    if (handlingFatal) {
      return;
    }
    handlingFatal = true;

    logger.error(`Fatal ${kind}: ${formatFatalError(error)}`);

    try {
      const stopTelegramPolling = options.getStopTelegramPolling?.();
      if (stopTelegramPolling) {
        await runWithTimeout(
          stopTelegramPolling,
          cleanupTimeoutMs,
          "Timed out stopping Telegram polling after fatal error",
          logger,
        );
      }
    } catch (stopError) {
      logger.error(`Failed to stop Telegram polling after fatal error: ${formatFatalError(stopError)}`);
    }

    try {
      const fatalBot = options.getBot?.();
      if (fatalBot) {
        await runWithTimeout(
          () => fatalBot.stop(),
          cleanupTimeoutMs,
          "Timed out stopping Telegram bot after fatal error",
          logger,
        );
      }
    } catch (stopError) {
      logger.error(`Failed to stop Telegram bot after fatal error: ${formatFatalError(stopError)}`);
    }

    try {
      options.getStopMailboxBridge?.()?.();
    } catch (mailboxError) {
      logger.error(`Failed to stop mailbox bridge after fatal error: ${formatFatalError(mailboxError)}`);
    }

    try {
      options.getRegistry?.()?.disposeAll();
    } catch (disposeError) {
      logger.error(`Failed to dispose Codex sessions after fatal error: ${formatFatalError(disposeError)}`);
    }

    exit(1);
  };

  processLike.once("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
  processLike.once("uncaughtException", (error) => handleFatal("uncaughtException", error));
}

function formatFatalError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function runWithTimeout(
  task: () => void | Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
  logger: Logger,
): Promise<void> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const taskPromise = Promise.resolve()
    .then(task)
    .catch((error) => {
      if (timedOut) {
        logger.error(`${timeoutMessage} later failed: ${formatFatalError(error)}`);
        return;
      }
      throw error;
    });
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      logger.error(`${timeoutMessage} after ${timeoutMs}ms`);
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
