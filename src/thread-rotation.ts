/**
 * thread-rotation — orchestration brain for telecodex auto thread rotation (ALB-1011).
 *
 * Composes the two pure pieces — `rotation-policy` (when to rotate) and
 * `handoff-buffer` (what to carry forward) — into a tiny per-chat state machine
 * that bot.ts drives at two seams:
 *
 *   - after a turn completes:  recordTurn()  → buffer the exchange + flag if heavy
 *   - before the next turn:    takeRotationHandoff() → if flagged, get the HANDOFF
 *                              preamble and clear the flag (caller then newThread()s)
 *
 * Keeping the logic here (not inline in handleUserPrompt) makes it fully unit
 * testable and keeps the bot.ts change to a few lines at each seam.
 */

import {
  type HandoffContext,
  type HandoffEntry,
  type HandoffReason,
  appendEntry,
  renderHandoff,
} from "./handoff-buffer.js";
import { contextFillRatio, resolveHardCap, shouldForceRotate, shouldRotate } from "./rotation-policy.js";

export interface ChatRotationState {
  /** Rolling window of recent exchanges, independent of thread boundaries. */
  buffer: HandoffEntry[];
  /** Set once a turn crosses the threshold; consumed by the next turn's rotation. */
  pendingRotation: boolean;
  /**
   * Set once a turn crosses the hard cap (ALB-1205): the next turn must not run
   * on the over-cap thread. Optional for backward compatibility with persisted
   * pre-ALB-1205 state (absent = false).
   */
  pendingMandatory?: boolean;
  /** User text of a turn that was aborted mid-answer (ALB-1205); absent = none. */
  interruptedTurn?: string;
  /** Fill ratio of the last turn that reported usage (ALB-1205); absent = unknown. */
  lastKnownRatio?: number;
}

export interface RotationConfig {
  /** Master on/off. When false, turns are still buffered but rotation never fires. */
  enabled: boolean;
  /** Fraction of the context window that triggers rotation. */
  threshold: number;
  /** Effective model context window. */
  contextWindow: number;
  /**
   * Hard-cap fraction (ALB-1205). Invalid values or values not strictly above
   * `threshold` disable the hard cap without touching regular rotation.
   */
  hardCap?: number;
  /** Ring-buffer cap (defaults to handoff-buffer's default). */
  maxEntries?: number;
}

export interface CompletedTurn {
  userText: string;
  assistantText?: string;
  /** Input tokens of the just-completed turn (≈ current context fill). */
  lastInputTokens?: number;
}

export function emptyChatState(): ChatRotationState {
  return { buffer: [], pendingRotation: false };
}

/**
 * Fold a completed turn into the chat state: append the user message and (if any)
 * the assistant reply to the rolling buffer, then decide whether the next turn
 * should rotate. The pending flag is sticky — once set it stays until consumed.
 */
export function recordTurn(
  state: ChatRotationState,
  turn: CompletedTurn,
  cfg: RotationConfig,
): ChatRotationState {
  let buffer = appendEntry(state.buffer, { role: "user", text: turn.userText }, cfg.maxEntries);
  if (turn.assistantText) {
    buffer = appendEntry(buffer, { role: "assistant", text: turn.assistantText }, cfg.maxEntries);
  }

  const sawUsage = typeof turn.lastInputTokens === "number";
  const heavy =
    cfg.enabled && sawUsage
      ? shouldRotate({
          lastInputTokens: turn.lastInputTokens!,
          contextWindow: cfg.contextWindow,
          threshold: cfg.threshold,
        })
      : false;
  const mandatory =
    cfg.enabled && sawUsage
      ? shouldForceRotate({
          lastInputTokens: turn.lastInputTokens!,
          contextWindow: cfg.contextWindow,
          threshold: cfg.threshold,
          hardCap: cfg.hardCap,
        })
      : false;
  const ratio = sawUsage ? contextFillRatio(turn.lastInputTokens!, cfg.contextWindow) : 0;

  const next: ChatRotationState = { buffer, pendingRotation: state.pendingRotation || heavy || mandatory };
  if (state.pendingMandatory || mandatory) {
    next.pendingMandatory = true;
  }
  if (state.interruptedTurn !== undefined) {
    next.interruptedTurn = state.interruptedTurn;
  }
  const lastKnownRatio = ratio > 0 ? ratio : state.lastKnownRatio;
  if (lastKnownRatio !== undefined) {
    next.lastKnownRatio = lastKnownRatio;
  }
  return next;
}

/**
 * Fold a mid-turn interruption (timeout abort) into the chat state (ALB-1205):
 * when the last known fill ratio already crossed the rotate threshold, flag a
 * rotation and remember the interrupted user text so the next thread's HANDOFF
 * can carry a 最后断点 section. No-op when the feature is disabled, the ratio is
 * unknown/light, or the threshold is misconfigured (fail safe, same spirit as
 * shouldRotate). Upgrades to mandatory when the ratio also crossed the hard cap.
 */
export function recordInterruptedTurn(
  state: ChatRotationState,
  userText: string,
  cfg: RotationConfig,
): ChatRotationState {
  if (!cfg.enabled) {
    return state;
  }
  if (!Number.isFinite(cfg.threshold) || cfg.threshold <= 0 || cfg.threshold > 1) {
    return state;
  }
  const ratio = state.lastKnownRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < cfg.threshold) {
    return state;
  }

  const next: ChatRotationState = { ...state, pendingRotation: true };
  const text = typeof userText === "string" ? userText.trim() : "";
  if (text) {
    next.interruptedTurn = text;
  }
  const cap = resolveHardCap(cfg.hardCap, cfg.threshold);
  if (cap !== undefined && ratio >= cap) {
    next.pendingMandatory = true;
  }
  return next;
}

export interface RotationHandoff {
  /** The preamble to prepend to the next user turn, or null if not rotating. */
  handoff: string | null;
  /** State with the pending flags cleared (buffer preserved for rolling context). */
  state: ChatRotationState;
  /** True when the consumed rotation had crossed the hard cap (ALB-1205). */
  mandatory: boolean;
  /** Interrupted-turn user text carried into the handoff, if any (ALB-1205). */
  interruptedTurn?: string;
}

/** Extra caller-supplied context rendered into the handoff (ALB-1205). */
export interface TakeRotationHandoffExtras {
  /** Verbatim queued-but-unanswered user messages, oldest first. */
  unanswered?: string[];
}

/**
 * If a rotation is pending (and the feature is enabled), render the HANDOFF
 * preamble from the rolling buffer and clear the flags. The buffer (and the last
 * known ratio) are preserved so the next rotation still carries rolling context;
 * `pendingRotation`, `pendingMandatory`, and `interruptedTurn` are all consumed
 * together. Idempotent: a second call after clearing returns null.
 */
export function takeRotationHandoff(
  state: ChatRotationState,
  cfg: RotationConfig,
  extras: TakeRotationHandoffExtras = {},
): RotationHandoff {
  if (!cfg.enabled || !state.pendingRotation) {
    return { handoff: null, state, mandatory: false };
  }
  const mandatory = state.pendingMandatory === true;
  const interruptedTurn = state.interruptedTurn;
  const reason: HandoffReason = mandatory ? "hard-cap" : interruptedTurn ? "timeout-abort" : "threshold";
  const context: HandoffContext = {
    reason,
    ratio: state.lastKnownRatio,
    unanswered: extras.unanswered,
    interruptedTurn,
  };
  const handoff = renderHandoff(state.buffer, context);
  const nextState: ChatRotationState = { buffer: state.buffer, pendingRotation: false };
  if (state.lastKnownRatio !== undefined) {
    nextState.lastKnownRatio = state.lastKnownRatio;
  }
  return { handoff, state: nextState, mandatory, interruptedTurn };
}
