import { describe, expect, it } from "vitest";

import {
  PENDING_ANSWER_MAX_PER_CONTEXT,
  PENDING_ANSWER_SUMMARY_LIMIT,
  PendingAnswerLedger,
  formatPendingAnswerReprompt,
} from "../src/pending-answer-guard.js";

const KEY = "chat-42";
const neverQueued = (): boolean => false;

describe("PendingAnswerLedger (ALB-1339 欠答账本)", () => {
  it("marks an answered message off the ledger", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "第一问");
    expect(ledger.pendingCount(KEY)).toBe(1);

    ledger.markAnswered(KEY, 900);
    expect(ledger.pendingCount(KEY)).toBe(0);
    expect(ledger.takeOverdue(KEY, ledger.snapshotSeq(), neverQueued)).toEqual([]);
  });

  it("takeOverdue returns only entries recorded before the turn-start snapshot", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "turn 开始前收到、被吞的一条");
    const turnStartSeq = ledger.snapshotSeq();
    ledger.record(KEY, 901, "turn 进行中才收到的一条");

    const overdue = ledger.takeOverdue(KEY, turnStartSeq, neverQueued);
    expect(overdue.map((entry) => entry.msgId)).toEqual([900]);
    // The mid-turn message stays pending (it is not this turn's debt).
    expect(ledger.pendingCount(KEY)).toBe(1);
  });

  it("takeOverdue removes what it returns so a message is re-prompted at most once", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "被吞的一条");
    const turnStartSeq = ledger.snapshotSeq();

    expect(ledger.takeOverdue(KEY, turnStartSeq, neverQueued)).toHaveLength(1);
    expect(ledger.takeOverdue(KEY, turnStartSeq, neverQueued)).toEqual([]);
    expect(ledger.pendingCount(KEY)).toBe(0);
  });

  it("takeOverdue skips messages still sitting in the prompt queue", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "还排着队的一条");
    const turnStartSeq = ledger.snapshotSeq();

    const overdue = ledger.takeOverdue(KEY, turnStartSeq, (msgId) => msgId === 900);
    expect(overdue).toEqual([]);
    // Still pending: its own turn will strike it when it is answered.
    expect(ledger.pendingCount(KEY)).toBe(1);
  });

  it("truncates the stored summary to the first 80 characters", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "长".repeat(200));
    const [entry] = ledger.takeOverdue(KEY, ledger.snapshotSeq(), neverQueued);
    expect(entry.summary).toHaveLength(PENDING_ANSWER_SUMMARY_LIMIT);
  });

  it("ignores records without a Telegram message id", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, undefined, "没有 msgId 的一条");
    expect(ledger.pendingCount(KEY)).toBe(0);
  });

  it("caps the per-context ledger and keeps the newest entries", () => {
    const ledger = new PendingAnswerLedger();
    for (let i = 0; i < PENDING_ANSWER_MAX_PER_CONTEXT + 5; i += 1) {
      ledger.record(KEY, 1000 + i, `第 ${i} 条`);
    }
    expect(ledger.pendingCount(KEY)).toBe(PENDING_ANSWER_MAX_PER_CONTEXT);
    const overdue = ledger.takeOverdue(KEY, ledger.snapshotSeq(), neverQueued);
    expect(overdue[overdue.length - 1]?.msgId).toBe(1000 + PENDING_ANSWER_MAX_PER_CONTEXT + 4);
  });

  it("clear drops all state for a context key", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "一条");
    ledger.record("other", 901, "别的 context 的一条");
    ledger.clear(KEY);
    expect(ledger.pendingCount(KEY)).toBe(0);
    expect(ledger.pendingCount("other")).toBe(1);
  });

  it("contexts are isolated from each other", () => {
    const ledger = new PendingAnswerLedger();
    ledger.record(KEY, 900, "A 家的");
    ledger.record("other", 901, "B 家的");
    ledger.markAnswered("other", 901);
    expect(ledger.pendingCount(KEY)).toBe(1);
    expect(ledger.pendingCount("other")).toBe(0);
  });
});

describe("formatPendingAnswerReprompt", () => {
  it("carries the 欠答自查 marker, an HH:MM timestamp, and each summary", () => {
    const ts = new Date(2026, 6, 10, 9, 5).getTime();
    const text = formatPendingAnswerReprompt([
      { msgId: 900, summary: "帮我看下那台机器", ts, seq: 1 },
      { msgId: 901, summary: "另外那单跟一下", ts, seq: 2 },
    ]);
    expect(text).toContain("欠答自查");
    expect(text).toContain("09:05");
    expect(text).toContain("帮我看下那台机器");
    expect(text).toContain("另外那单跟一下");
    expect(text).toContain("还没答");
  });
});
