/**
 * rotation-policy — pure decision logic for telecodex auto thread rotation (ALB-1011).
 *
 * Theo and the other Codex dev bots run on a single per-chat Codex thread that
 * telecodex never rotates. The thread therefore lives permanently near the
 * model's compression ceiling: every turn re-sends a near-full context, which —
 * compounded by xhigh reasoning — makes each turn slow enough to hit the 30-min
 * turn lease / KeepAlive restart and stop mid-answer.
 *
 * The fix mirrors Claude Code's context-% page-flip: when the most recent turn's
 * input tokens cross a fraction of the model context window, rotate to a fresh
 * thread (carrying a HANDOFF preamble forward). This module is the pure trigger;
 * the runtime wiring lives in bot.ts / codex-session.ts.
 */

/** gpt-5.5 context window, from the rollout `token_count.info.model_context_window`. */
export const DEFAULT_CONTEXT_WINDOW = 258400;

/**
 * Default rotation threshold as a fraction of the context window. CC page-flips
 * at 0.48; Codex turns carry heavier xhigh reasoning, so we leave a touch more
 * headroom and flip at 0.45. Overridable via config at the call site.
 */
export const DEFAULT_ROTATE_THRESHOLD = 0.45;

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Token-count info as it appears in a Codex rollout `token_count` event payload. */
export interface TokenCountInfo {
  model_context_window?: number | null;
}

/**
 * Resolve the effective context window. Prefers the live value Codex reports in
 * the rollout `token_count.info`, then an explicit fallback (e.g. from config),
 * then the gpt-5.5 default. Any zero / negative / non-finite value is ignored so
 * a malformed event can never collapse the window to an absurd number.
 */
export function resolveContextWindow(info?: TokenCountInfo | null, fallback?: number): number {
  if (info && isPositiveFinite(info.model_context_window)) {
    return info.model_context_window;
  }
  if (isPositiveFinite(fallback)) {
    return fallback;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Fraction of the context window consumed by the most recent turn's input.
 * Returns 0 when either number is non-positive (nothing to decide on yet).
 */
export function contextFillRatio(lastInputTokens: number, contextWindow: number): number {
  if (!isPositiveFinite(contextWindow) || !isPositiveFinite(lastInputTokens)) {
    return 0;
  }
  return lastInputTokens / contextWindow;
}

export interface ShouldRotateInput {
  /** Input tokens of the most recently completed turn (≈ current context fill). */
  lastInputTokens: number;
  /** Effective model context window (see resolveContextWindow). */
  contextWindow: number;
  /** Rotate when the fill ratio reaches this fraction. Valid range (0, 1]. */
  threshold: number;
}

/**
 * Decide whether the current thread should rotate. Fails safe to `false` on any
 * missing/invalid input or a misconfigured threshold — a bad config disables
 * rotation rather than rotating every turn (threshold ≤ 0) or silently never
 * firing (threshold > 1) without anyone noticing.
 */
export function shouldRotate({ lastInputTokens, contextWindow, threshold }: ShouldRotateInput): boolean {
  if (!isPositiveFinite(threshold) || threshold > 1) {
    return false;
  }
  const ratio = contextFillRatio(lastInputTokens, contextWindow);
  if (ratio <= 0) {
    return false;
  }
  return ratio >= threshold;
}
