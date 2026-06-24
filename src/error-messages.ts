/**
 * Translate raw errors into user-friendly Telegram messages.
 * Raw details are preserved for console logging only.
 */

export interface FriendlyError {
  userMessage: string;
  logMessage: string;
}

const CODEX_RATE_LIMIT_RE = /429|rate.?limit|too many requests/i;
const CODEX_USAGE_CAP_RE = /usage.?(?:limit|cap|capped)|purchase more credits|try again at/i;
const CODEX_CAPACITY_DEFAULT_RETRY_DELAY_MS = 60_000;
const MAX_TIMEOUT_DELAY_MS = 2_147_000_000;
const TRY_AGAIN_AT_RE = /try again at/i;

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ENETUNREACH|fetch failed/i,
    message: "Cannot reach the Codex API. Check your network connection.",
  },
  {
    pattern: /429|rate.?limit|too many requests/i,
    message: "Rate limited by the API. Wait a moment and try again.",
  },
  {
    pattern: /usage.?(?:limit|cap|capped)|purchase more credits|try again at/i,
    message: "Codex usage limit reached. Wait for quota reset or use an approved fallback profile.",
  },
  {
    pattern: /401|unauthorized|authentication|invalid.*api.?key/i,
    message: "Authentication failed. Use /login to re-authenticate or check your API key.",
  },
  {
    pattern: /403|forbidden|permission/i,
    message: "Access denied. Check your API key permissions.",
  },
  {
    pattern: /404.*model|model.*not.*found|invalid.*model|model.*does not exist/i,
    message: "Model not available. Use /model to pick a different one.",
  },
  {
    pattern: /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    message: "Request timed out. Try a shorter prompt or use /retry.",
  },
  {
    pattern: /500|internal.?server.?error/i,
    message: "The API returned a server error. Try again in a moment.",
  },
  {
    pattern: /502|503|504|bad.?gateway|service.?unavailable/i,
    message: "The API is temporarily unavailable. Try again shortly.",
  },
  {
    pattern: /context.?length|token.?limit|too.?long/i,
    message: "The conversation is too long for this model. Start a /new thread.",
  },
  {
    pattern: /^(?:AbortError|The operation was aborted)/i,
    message: "⏹ Aborted",
  },
];

export function translateError(error: unknown): FriendlyError {
  const raw = extractRawMessage(error);
  const logMessage = raw;

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return { userMessage: message, logMessage };
    }
  }

  const cleaned = stripStackTrace(raw);
  return { userMessage: cleaned, logMessage };
}

export function friendlyErrorText(error: unknown): string {
  return translateError(error).userMessage;
}

export function isRetryableCodexCapacityError(error: unknown): boolean {
  const raw = extractRawMessage(error);
  return CODEX_RATE_LIMIT_RE.test(raw) || (CODEX_USAGE_CAP_RE.test(raw) && TRY_AGAIN_AT_RE.test(raw));
}

export function codexCapacityRetryDelayMs(error: unknown, now = Date.now()): number | undefined {
  const raw = extractRawMessage(error);
  if (CODEX_RATE_LIMIT_RE.test(raw)) {
    return CODEX_CAPACITY_DEFAULT_RETRY_DELAY_MS;
  }

  if (!CODEX_USAGE_CAP_RE.test(raw) || !TRY_AGAIN_AT_RE.test(raw)) {
    return undefined;
  }
  const resetAt = parseCodexTryAgainAt(raw);
  if (resetAt === undefined) {
    return undefined;
  }

  return Math.max(0, Math.min(resetAt - now, MAX_TIMEOUT_DELAY_MS));
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: Error }).cause;
    const base = error.message || String(error);
    return cause?.message ? `${base}: ${cause.message}` : base;
  }

  return String(error);
}

function stripStackTrace(message: string): string {
  // Remove stack frame lines (lines starting with "at ")
  const lines = message.split("\n").filter((line) => !line.trim().startsWith("at "));
  return lines.join("\n").trim() || message.trim();
}

function parseCodexTryAgainAt(message: string): number | undefined {
  const match = message.match(/try again at\s+([^.\n]+)/i);
  if (!match?.[1]) {
    return undefined;
  }

  const cleaned = match[1].replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1").trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}
