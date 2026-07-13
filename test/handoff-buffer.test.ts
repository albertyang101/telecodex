import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ENTRY_CHARS,
  DEFAULT_MAX_HANDOFF_CHARS,
  DEFAULT_MAX_HANDOFF_ENTRIES,
  HANDOFF_MARKER,
  type HandoffContext,
  type HandoffEntry,
  type HandoffMessage,
  appendEntry,
  renderHandoff,
} from "../src/handoff-buffer.js";

function entry(role: HandoffEntry["role"], text: string): HandoffEntry {
  return { role, text };
}

describe("handoff-buffer", () => {
  describe("appendEntry", () => {
    it("appends an entry and returns a new array (does not mutate input)", () => {
      const buf: HandoffEntry[] = [entry("user", "hi")];
      const next = appendEntry(buf, entry("assistant", "hello"));
      expect(next).toHaveLength(2);
      expect(next[1]).toEqual(entry("assistant", "hello"));
      expect(buf).toHaveLength(1); // original untouched
    });

    it("trims to the most recent maxEntries (ring buffer)", () => {
      let buf: HandoffEntry[] = [];
      for (let i = 0; i < 25; i++) {
        buf = appendEntry(buf, entry("user", `m${i}`), 20);
      }
      expect(buf).toHaveLength(20);
      expect(buf[0]).toEqual(entry("user", "m5")); // oldest kept is m5
      expect(buf[19]).toEqual(entry("user", "m24")); // newest
    });

    it("skips empty / whitespace-only text without growing the buffer", () => {
      const buf: HandoffEntry[] = [entry("user", "real")];
      expect(appendEntry(buf, entry("assistant", "   "))).toHaveLength(1);
      expect(appendEntry(buf, entry("assistant", ""))).toHaveLength(1);
    });
  });

  describe("renderHandoff", () => {
    const sample: HandoffEntry[] = [
      entry("user", "Theo 帮我看下部署脚本"),
      entry("assistant", "看完了，脚本里有个超时没兜住"),
      entry("user", "那就修一下"),
    ];

    it("emits a non-empty preamble carrying the rotation marker", () => {
      const out = renderHandoff(sample);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(HANDOFF_MARKER);
    });

    it("includes the recent exchange text in order", () => {
      const out = renderHandoff(sample);
      expect(out).toContain("Theo 帮我看下部署脚本");
      expect(out).toContain("脚本里有个超时没兜住");
      expect(out).toContain("那就修一下");
      // user text appears before the assistant reply that followed it
      expect(out.indexOf("帮我看下部署脚本")).toBeLessThan(out.indexOf("超时没兜住"));
    });

    it("marks the recent-conversation section as already answered (契约 §A.2)", () => {
      // 待答侧已有显式的 未答消息 / 最后断点 段；已答侧也必须显式标注，
      // 新棒才能据此不重答已答的（而不是靠 [用户]/[你] 成对去猜）。
      const out = renderHandoff(sample);
      expect(out).toContain("--- 旧 thread 最近对话（以下均已答过，勿重答） ---");
      const withContext = renderHandoff(sample, { reason: "threshold" });
      expect(withContext).toContain("--- 旧 thread 最近对话（以下均已答过，勿重答） ---");
    });

    it("truncates an over-long single entry", () => {
      const huge = "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 500);
      const out = renderHandoff([entry("user", huge)], { maxEntryChars: DEFAULT_MAX_ENTRY_CHARS });
      expect(out).toContain("…");
      expect(out).not.toContain(huge);
    });

    it("caps total size, keeping the most recent entries", () => {
      const many: HandoffEntry[] = [];
      for (let i = 0; i < 100; i++) {
        many.push(entry(i % 2 === 0 ? "user" : "assistant", `entry-${i}-${"y".repeat(200)}`));
      }
      const out = renderHandoff(many, { maxTotalChars: 4000 });
      expect(out.length).toBeLessThanOrEqual(4000 + HANDOFF_MARKER.length + 600); // cap + header overhead
      expect(out).toContain("entry-99"); // newest survives
      expect(out).not.toContain("entry-0-"); // oldest dropped
    });

    it("still returns a valid (thin) preamble for an empty buffer", () => {
      const out = renderHandoff([]);
      expect(out).toContain(HANDOFF_MARKER);
      expect(out.length).toBeGreaterThan(0);
    });

    it("states in the header that live messages override the handoff narrative (契约 §A.1)", () => {
      // The live-envelope-supremacy line must be part of the fixed header so it
      // survives every render shape: with conversation, empty buffer, and context.
      for (const out of [
        renderHandoff(sample),
        renderHandoff([]),
        renderHandoff(sample, { reason: "hard-cap" }),
      ]) {
        expect(out).toContain("实时收到的用户消息永远压过本交接单的叙述");
        expect(out).toContain("归属只认实时信封");
        // ...and it must sit in the header, before any context/conversation section.
        expect(out.indexOf("实时收到的用户消息")).toBeLessThan(out.indexOf("--- 交接结束"));
        expect(out.indexOf("实时收到的用户消息")).toBeLessThan(200);
      }
    });
  });

  describe("renderHandoff with structured context (ALB-1205)", () => {
    const sample: HandoffEntry[] = [
      entry("user", "部署脚本超时没兜住"),
      entry("assistant", "我看下，先复现"),
      entry("user", "好，抓紧"),
    ];

    it("stays byte-identical to the legacy render when no context is passed", () => {
      expect(renderHandoff(sample, undefined)).toBe(renderHandoff(sample));
      expect(renderHandoff(sample, undefined, { maxTotalChars: 4000 })).toBe(
        renderHandoff(sample, { maxTotalChars: 4000 }),
      );
    });

    it("renders a human-readable reason line for each rotation reason", () => {
      const threshold = renderHandoff(sample, { reason: "threshold" });
      expect(threshold).toContain("翻页原因");
      expect(threshold).toContain("常规阈值");

      const hardCap = renderHandoff(sample, { reason: "hard-cap" });
      expect(hardCap).toContain("硬上限");
      expect(hardCap).toContain("强制");

      const timeoutAbort = renderHandoff(sample, { reason: "timeout-abort" });
      expect(timeoutAbort).toContain("超时");
      expect(timeoutAbort).toContain("中断");
    });

    it("includes the fill ratio in the reason line when provided", () => {
      const out = renderHandoff(sample, { reason: "hard-cap", ratio: 0.63 });
      expect(out).toContain("63%");
    });

    it("never renders an impossible percentage from stale persisted ratio data", () => {
      const out = renderHandoff(sample, { reason: "hard-cap", ratio: 9.48 });
      expect(out).toContain("100%");
      expect(out).not.toContain("948%");
    });

    it("omits the ratio number when it is not provided", () => {
      const out = renderHandoff(sample, { reason: "threshold" });
      expect(out).not.toContain("%");
    });

    it("always renders the recovery-discipline pointer (AGENTS.md + Linear, no inlined content)", () => {
      const out = renderHandoff(sample, { reason: "threshold" });
      expect(out).toContain("恢复指引");
      expect(out).toContain("AGENTS.md");
      expect(out).toContain("Linear");
    });

    it("renders explicit deduplicated Linear control-plane refs after protected owner work", () => {
      const out = renderHandoff([], {
        reason: "threshold",
        linearIssues: ["ALB-1201", "alb-958", "ALB-1201"],
        unanswered: ["继续 ALB-1208"],
      });
      expect(out).toContain("--- Linear 在途控制面 ---");
      expect(out).toContain("ALB-1201");
      expect(out).toContain("ALB-958");
      expect(out.match(/ALB-1201/g)).toHaveLength(1);
      expect(out).toContain("issue/comments/status/close criteria");
      expect(out.indexOf("Linear 在途控制面")).toBeGreaterThan(out.indexOf("未答消息"));
    });

    it("mechanically pins responsibility, priority, and unknown boundaries for a fresh thread (ALB-1404)", () => {
      const out = renderHandoff([], { reason: "threshold" });
      expect(out).toContain("当前责任：未内联");
      expect(out).toContain("当前优先级：未内联");
      expect(out).toContain("当前未知：未内联");
      expect(out).toContain("CURRENT_HANDOFF.md");
      expect(out).toContain("Linear（唯一真相）");
      expect(out).toContain("不脑补");
      expect(out.indexOf("当前责任")).toBeLessThan(out.indexOf("--- 交接结束"));
    });

    it("renders stable message ids for duplicate-text unanswered messages (ALB-1404)", () => {
      const out = renderHandoff([], {
        reason: "threshold",
        unanswered: [
          { messageId: 22, text: "同一句话" },
          { messageId: 23, text: "同一句话" },
        ],
      });
      expect(out).toContain("message_id=22");
      expect(out).toContain("message_id=23");
      expect(out.match(/同一句话/g)).toHaveLength(2);
    });

    it("protects exact undelivered output and forbids regeneration across rotation (ALB-1404)", () => {
      const exact = "**最终结果**\n\n只差这一段尚未送达。";
      const out = renderHandoff([], {
        reason: "threshold",
        pendingOutputs: [{ messageId: 31, text: exact }],
      });
      expect(out).toContain("待送达回复");
      expect(out).toContain("message_id=31");
      expect(out).toContain(exact);
      expect(out).toContain("不要重跑");
      expect(out).toContain("不要重复生成");
    });

    it("references the durable exact source when a pending-output preview is truncated (ALB-1404 review I1)", () => {
      const longExact = "LONG_PENDING_EXACT_" + "甲".repeat(3000);
      const sha = "a".repeat(64);
      const out = renderHandoff([], {
        reason: "threshold",
        pendingOutputs: [{
          messageId: 41,
          debtId: "debt-long-41",
          contentSha256: sha,
          text: longExact,
        }],
      });
      expect(out).toContain(".telecodex/delivery-debts.json");
      expect(out).toContain("debt-long-41");
      expect(out).toContain(sha);
      expect(out).toContain("预览");
      expect(out).not.toContain(longExact);
    });

    it("renders each unanswered message verbatim under a 未答消息 section", () => {
      const out = renderHandoff(sample, {
        reason: "threshold",
        unanswered: ["帮我查下 CI 挂没挂", "另外今晚的行程改一下"],
      });
      expect(out).toContain("未答消息");
      expect(out).toContain("帮我查下 CI 挂没挂");
      expect(out).toContain("另外今晚的行程改一下");
    });

    it("truncates over-long unanswered messages with the same per-entry bound", () => {
      const huge = "u".repeat(DEFAULT_MAX_ENTRY_CHARS + 500);
      const out = renderHandoff(sample, { reason: "threshold", unanswered: [huge] }, {
        maxEntryChars: DEFAULT_MAX_ENTRY_CHARS,
      });
      expect(out).toContain("…");
      expect(out).not.toContain(huge);
    });

    it("renders the interrupted turn under a 最后断点 section with a continue instruction", () => {
      const out = renderHandoff(sample, {
        reason: "timeout-abort",
        interruptedTurn: "把 rotation 的设计稿写完",
      });
      expect(out).toContain("最后断点");
      expect(out).toContain("把 rotation 的设计稿写完");
      expect(out).toContain("接着答");
    });

    it("omits the 未答消息 and 最后断点 sections when there is nothing to show", () => {
      const out = renderHandoff(sample, { reason: "threshold" });
      expect(out).not.toContain("未答消息");
      expect(out).not.toContain("最后断点");
    });

    it("orders sections: reason → recovery → unanswered → pending output → interrupted → recent conversation", () => {
      const out = renderHandoff(sample, {
        reason: "hard-cap",
        unanswered: ["queued-question"],
        pendingOutputs: [{ messageId: 9, text: "pending-output" }],
        interruptedTurn: "interrupted-question",
      });
      const reasonAt = out.indexOf("翻页原因");
      const recoveryAt = out.indexOf("恢复指引");
      const unansweredAt = out.indexOf("未答消息");
      const pendingAt = out.indexOf("--- 待送达回复");
      const interruptedAt = out.indexOf("最后断点");
      const recentAt = out.indexOf("旧 thread 最近对话");
      expect(reasonAt).toBeGreaterThanOrEqual(0);
      expect(recoveryAt).toBeGreaterThan(reasonAt);
      expect(unansweredAt).toBeGreaterThan(recoveryAt);
      expect(pendingAt).toBeGreaterThan(unansweredAt);
      expect(interruptedAt).toBeGreaterThan(pendingAt);
      expect(recentAt).toBeGreaterThan(interruptedAt);
    });

    it("keeps unanswered + interrupted alive under budget pressure by shedding old conversation first", () => {
      const many: HandoffEntry[] = [];
      for (let i = 0; i < 100; i++) {
        many.push(entry(i % 2 === 0 ? "user" : "assistant", `entry-${i}-${"y".repeat(200)}`));
      }
      const out = renderHandoff(
        many,
        {
          reason: "hard-cap",
          ratio: 0.66,
          unanswered: ["queued-alpha", "queued-beta"],
          interruptedTurn: "interrupted-gamma",
        },
        { maxTotalChars: 4000 },
      );
      expect(out.length).toBeLessThanOrEqual(4000 + HANDOFF_MARKER.length + 600);
      expect(out).toContain("queued-alpha");
      expect(out).toContain("queued-beta");
      expect(out).toContain("interrupted-gamma");
      expect(out).toContain("entry-99"); // newest conversation still first to survive
      expect(out).not.toContain("entry-0-"); // oldest conversation sheds first
    });

    it("keeps the total cap when pending output and unanswered work compete for budget (ALB-1404)", () => {
      const pendingOutputs = Array.from({ length: 10 }, (_, index) => ({
        messageId: 100 + index,
        text: "pending-" + index + "-" + "p".repeat(1800),
      }));
      const unanswered = Array.from({ length: 4 }, (_, index) => ({
        messageId: 200 + index,
        text: "unanswered-" + index + "-" + "u".repeat(1800),
      }));
      const out = renderHandoff(
        sample,
        {
          reason: "hard-cap",
          pendingOutputs,
          unanswered,
          interruptedTurn: "interrupted-" + "i".repeat(1800),
        },
        { maxTotalChars: 4000 },
      );
      expect(out.length).toBeLessThanOrEqual(4000);
      expect(out).toContain("未答消息");
      expect(out).not.toContain("待送达回复");
      expect(out).not.toContain("最后断点");
    });

    it("finishes all higher-priority owner messages before admitting pending or interrupted work (ALB-1404 review I5)", () => {
      const context: HandoffContext = {
        reason: "hard-cap",
        unanswered: [
          { messageId: 1, text: "OWNER_ONE_" + "a".repeat(1000) },
          { messageId: 2, text: "OWNER_TWO_" + "b".repeat(1000) },
        ],
        pendingOutputs: [{ messageId: 3, text: "PENDING_LOWER_" + "p".repeat(1000) }],
        interruptedTurn: "INTERRUPTED_LOWER_" + "i".repeat(1000),
      };
      const tight = renderHandoff([], context, { maxTotalChars: 2000 });
      expect(tight).toContain("OWNER_ONE_");
      expect(tight).not.toContain("PENDING_LOWER_");
      expect(tight).not.toContain("INTERRUPTED_LOWER_");

      const larger = renderHandoff([], context, { maxTotalChars: 3000 });
      expect(larger).toContain("OWNER_ONE_");
      expect(larger).toContain("OWNER_TWO_");
    });

    it("keeps the oldest-first FIFO prefix inside owner, pending, and queued layers (ALB-1404 review I6)", () => {
      const assertPrefixOnly = (context: HandoffContext, prefix: string): void => {
        const out = renderHandoff([], context, { maxTotalChars: 1600 });
        expect(out).toContain(prefix + "_ONE_");
        expect(out).not.toContain(prefix + "_TWO_");
        expect(out).not.toContain(prefix + "_THREE_TINY");
      };
      const items = (prefix: string): HandoffMessage[] => [
        { messageId: 1, text: prefix + "_ONE_" + "a".repeat(600) },
        { messageId: 2, text: prefix + "_TWO_" + "b".repeat(1200) },
        { messageId: 3, text: prefix + "_THREE_TINY" },
      ];
      assertPrefixOnly({ reason: "hard-cap", unanswered: items("OWNER") }, "OWNER");
      assertPrefixOnly({ reason: "hard-cap", pendingOutputs: items("PENDING") }, "PENDING");
      assertPrefixOnly({ reason: "hard-cap", queuedMessages: items("QUEUED") }, "QUEUED");
    });

    it("treats maxTotalChars as a strict hard bound under combined pressure (ALB-1404 review I2)", () => {
      const out = renderHandoff(
        sample,
        {
          reason: "hard-cap",
          pendingOutputs: [{
            messageId: 1, debtId: "debt-1", contentSha256: "b".repeat(64),
            text: "p".repeat(3000),
          }],
          unanswered: [{ messageId: 2, text: "OWNER_UNANSWERED_" + "u".repeat(3000) }],
          queuedMessages: [{ messageId: 3, text: "QUEUED_FUTURE_" + "q".repeat(3000) }],
          interruptedTurn: "INTERRUPTED_" + "i".repeat(3000),
        },
        { maxTotalChars: 1000 },
      );
      expect(out.length).toBeLessThanOrEqual(1000);
      expect(out).toContain(HANDOFF_MARKER);
      expect(out).toContain("OWNER_UNANSWERED_");
    });

    it("still fits the default 6000-char budget with a full context attached", () => {
      const many: HandoffEntry[] = [];
      for (let i = 0; i < 100; i++) {
        many.push(entry(i % 2 === 0 ? "user" : "assistant", `entry-${i}-${"y".repeat(300)}`));
      }
      const context: HandoffContext = {
        reason: "hard-cap",
        ratio: 0.61,
        unanswered: ["q1", "q2", "q3"],
        interruptedTurn: "被打断的问题",
      };
      const out = renderHandoff(many, context);
      expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_HANDOFF_CHARS + HANDOFF_MARKER.length + 600);
    });
  });

  describe("defaults", () => {
    it("exports sane bounds", () => {
      expect(DEFAULT_MAX_HANDOFF_ENTRIES).toBeGreaterThan(0);
      expect(DEFAULT_MAX_ENTRY_CHARS).toBeGreaterThan(0);
      expect(DEFAULT_MAX_HANDOFF_CHARS).toBeGreaterThan(DEFAULT_MAX_ENTRY_CHARS);
    });

    it("pins the per-entry excerpt cap at 1200 (契约 §A.4, ALB-1220)", () => {
      expect(DEFAULT_MAX_ENTRY_CHARS).toBe(1200);
    });
  });
});
