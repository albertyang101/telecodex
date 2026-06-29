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

import { type HandoffEntry, appendEntry, renderHandoff } from "./handoff-buffer.js";
import { shouldRotate } from "./rotation-policy.js";

export interface ChatRotationState {
  /** Rolling window of recent exchanges, independent of thread boundaries. */
  buffer: HandoffEntry[];
  /** Set once a turn crosses the threshold; consumed by the next turn's rotation. */
  pendingRotation: boolean;
}

export interface RotationConfig {
  /** Master on/off. When false, turns are still buffered but rotation never fires. */
  enabled: boolean;
  /** Fraction of the context window that triggers rotation. */
  threshold: number;
  /** Effective model context window. */
  contextWindow: number;
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

  const heavy =
    cfg.enabled && typeof turn.lastInputTokens === "number"
      ? shouldRotate({
          lastInputTokens: turn.lastInputTokens,
          contextWindow: cfg.contextWindow,
          threshold: cfg.threshold,
        })
      : false;

  return { buffer, pendingRotation: state.pendingRotation || heavy };
}

export interface RotationHandoff {
  /** The preamble to prepend to the next user turn, or null if not rotating. */
  handoff: string | null;
  /** State with the pending flag cleared (buffer preserved for rolling context). */
  state: ChatRotationState;
}

/**
 * If a rotation is pending (and the feature is enabled), render the HANDOFF
 * preamble from the rolling buffer and clear the flag. The buffer is preserved so
 * the next rotation still carries recent context. Idempotent: a second call after
 * clearing returns null.
 */
export function takeRotationHandoff(state: ChatRotationState, cfg: RotationConfig): RotationHandoff {
  if (!cfg.enabled || !state.pendingRotation) {
    return { handoff: null, state };
  }
  const handoff = renderHandoff(state.buffer);
  return { handoff, state: { buffer: state.buffer, pendingRotation: false } };
}
