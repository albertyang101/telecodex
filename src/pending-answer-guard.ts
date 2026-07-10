/**
 * ALB-1339 pending-answer guard (欠答检查).
 *
 * In-memory ledger of owner messages that have been received but not yet
 * answered, keyed by Telegram context key. The bridge records a message on
 * ingress (runOrQueuePrompt) and strikes it after the turn that answers it
 * finalizes successfully. Anything left in the ledger from before a turn
 * started — and no longer sitting in the prompt queue — was swallowed
 * (busy-queue drop / abort / usage-cap), and gets re-prompted back into the
 * same thread exactly once.
 *
 * Deliberately thin: no persistence (rotation-durable ledgers are the
 * ALB-1205 leg), no semantic judgement of whether a reply "really" answered
 * a message — a successful finalize for a message's own turn counts.
 *
 * Ordering uses a monotonic sequence number instead of wall-clock time so
 * that same-millisecond arrivals cannot race the turn-start snapshot; `ts`
 * is kept only for the human-readable HH:MM in the re-prompt text.
 */

export interface PendingAnswerEntry {
  msgId: number;
  summary: string;
  ts: number;
  seq: number;
}

export const PENDING_ANSWER_SUMMARY_LIMIT = 80;
/** Safety valve so a wedged context cannot grow the ledger unboundedly. */
export const PENDING_ANSWER_MAX_PER_CONTEXT = 20;

export class PendingAnswerLedger {
  private readonly ledgers = new Map<string, PendingAnswerEntry[]>();
  private seq = 0;

  /**
   * Current sequence watermark. Entries recorded at or after this snapshot
   * belong to messages that arrived during the turn taking the snapshot and
   * are never that turn's debt.
   */
  snapshotSeq(): number {
    return this.seq;
  }

  record(contextKey: string, msgId: number | undefined, text: string, now: number = Date.now()): void {
    if (msgId === undefined) {
      // Without a message id the entry could never be struck off; recording
      // it would guarantee a false re-prompt later.
      return;
    }

    const entries = this.ledgers.get(contextKey) ?? [];
    const summary = text.replace(/\s+/g, " ").trim().slice(0, PENDING_ANSWER_SUMMARY_LIMIT);
    const withoutDuplicate = entries.filter((entry) => entry.msgId !== msgId);
    withoutDuplicate.push({ msgId, summary, ts: now, seq: this.seq });
    this.seq += 1;
    while (withoutDuplicate.length > PENDING_ANSWER_MAX_PER_CONTEXT) {
      withoutDuplicate.shift();
    }
    this.ledgers.set(contextKey, withoutDuplicate);
  }

  markAnswered(contextKey: string, msgId: number | undefined): void {
    if (msgId === undefined) {
      return;
    }

    const entries = this.ledgers.get(contextKey);
    if (!entries) {
      return;
    }

    const remaining = entries.filter((entry) => entry.msgId !== msgId);
    if (remaining.length === 0) {
      this.ledgers.delete(contextKey);
    } else {
      this.ledgers.set(contextKey, remaining);
    }
  }

  /**
   * Entries recorded before `turnStartSeq` that are not still queued for a
   * turn of their own. Removes what it returns, so each swallowed message is
   * re-prompted at most once (灌完即划, anti-loop).
   */
  takeOverdue(
    contextKey: string,
    turnStartSeq: number,
    isStillQueued: (msgId: number) => boolean,
  ): PendingAnswerEntry[] {
    const entries = this.ledgers.get(contextKey);
    if (!entries || entries.length === 0) {
      return [];
    }

    const overdue = entries.filter((entry) => entry.seq < turnStartSeq && !isStillQueued(entry.msgId));
    if (overdue.length === 0) {
      return [];
    }

    const taken = new Set(overdue);
    const remaining = entries.filter((entry) => !taken.has(entry));
    if (remaining.length === 0) {
      this.ledgers.delete(contextKey);
    } else {
      this.ledgers.set(contextKey, remaining);
    }
    return overdue;
  }

  pendingCount(contextKey: string): number {
    return this.ledgers.get(contextKey)?.length ?? 0;
  }

  clear(contextKey: string): void {
    this.ledgers.delete(contextKey);
  }
}

function formatClockTime(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The auto prompt fed back into the same thread for swallowed messages.
 * Mechanical wording only — the model produces the actual catch-up reply.
 */
export function formatPendingAnswerReprompt(entries: PendingAnswerEntry[]): string {
  const lines = entries.map((entry) => `- ${formatClockTime(entry.ts)} 收到的那条『${entry.summary}』还没答`);
  return [
    "[欠答自查·telecodex 自动回灌] 下面这几条用户消息你收到了但一直没有回复（也不在处理队列里）。现在逐条补答，直接把答复发给用户：",
    ...lines,
  ].join("\n");
}
