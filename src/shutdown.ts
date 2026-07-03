type Logger = {
  error(message: string): void;
};

type StoppablePolling = {
  stop(): void | Promise<void>;
};

type IdleWaiter = {
  waitForIdle(): void | Promise<void>;
};

export async function stopPollingWithTimeout(
  polling: StoppablePolling | undefined,
  timeoutMs: number,
  logger: Logger = console,
): Promise<void> {
  if (!polling) {
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopPromise = Promise.resolve()
    .then(() => polling.stop())
    .catch((error) => {
      if (timedOut) {
        logger.error(`Timed out stopping Telegram polling later failed: ${formatError(error)}`);
        return;
      }
      throw error;
    });
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      logger.error(`Timed out stopping Telegram polling after ${timeoutMs}ms`);
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([stopPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export async function waitForIdleWithTimeout(
  target: IdleWaiter | undefined,
  timeoutMs: number,
  logger: Logger = console,
): Promise<void> {
  if (!target) {
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const idlePromise = Promise.resolve()
    .then(() => target.waitForIdle())
    .catch((error) => {
      if (timedOut) {
        logger.error("Timed out waiting for in-flight Telegram turn later failed: " + formatError(error));
        return;
      }
      throw error;
    });
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      logger.error("Timed out waiting for in-flight Telegram turn after " + timeoutMs + "ms");
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([idlePromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
