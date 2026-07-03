import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { startMailboxBridge } from "./mailbox.js";
import { runTelegramPollingWithRetry } from "./polling.js";
import { installFatalProcessHandlers } from "./process-lifecycle.js";
import { SessionRegistry } from "./session-registry.js";
import { stopPollingWithTimeout, waitForIdleWithTimeout } from "./shutdown.js";
import type { RunnerHandle } from "@grammyjs/runner";

const GRACEFUL_POLLING_STOP_TIMEOUT_MS = 4_000;
const GRACEFUL_IN_FLIGHT_DRAIN_TIMEOUT_MS = 600_000;

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let stopMailboxBridge: (() => void) | undefined;
let pollingHandle: RunnerHandle | undefined;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

installFatalProcessHandlers({
  getStopTelegramPolling: () => async () => {
    await pollingHandle?.stop();
  },
  getBot: () => bot,
  getStopMailboxBridge: () => stopMailboxBridge,
  getRegistry: () => registry,
});

try {
  const config = loadConfig();
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  stopMailboxBridge = startMailboxBridge(config, registry, {
    onFatalRecovery: (error) => {
      setImmediate(() => {
        throw error;
      });
    },
  });
  await registerCommands(bot);

  console.log("TeleCodex running");
  const authStatus = await checkAuthStatus(config.codexApiKey);
  console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
  if (!authStatus.authenticated) {
    console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
  }
  console.log(`Workspace: ${config.workspace}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  if (config.codexReasoningEffort) {
    console.log(`Default reasoning effort: ${config.codexReasoningEffort}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
  if (config.mailboxBridge.enabled) {
    console.log(`Mailbox bridge: ${config.mailboxBridge.persona} (${config.mailboxBridge.contextKey ?? `mailbox:${config.mailboxBridge.persona}`})`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCodex: ${message}`);
  registry?.disposeAll();
  process.exit(1);
}

const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownPromise) {
    return;
  }
  shutdownPromise = shutdownGracefully(signal);
};

const shutdownGracefully = async (signal: NodeJS.Signals): Promise<void> => {
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TeleCodex...`);
  stopMailboxBridge?.();

  try {
    await stopPollingWithTimeout(pollingHandle, GRACEFUL_POLLING_STOP_TIMEOUT_MS);
    await waitForIdleWithTimeout(bot, GRACEFUL_IN_FLIGHT_DRAIN_TIMEOUT_MS);
  } catch (error) {
    console.error("Failed during Telegram shutdown drain:", error instanceof Error ? error.message : String(error));
  } finally {
    registry?.disposeAll();
    console.log("TeleCodex stopped.");
    process.exit(0);
  }
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function startPolling(): Promise<void> {
  await runTelegramPollingWithRetry(bot!, {
    onHandle: (handle) => {
      pollingHandle = handle;
    },
    shouldStop: () => shuttingDown,
  });
}

await startPolling();
