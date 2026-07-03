import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ENTRY_CHARS,
  DEFAULT_MAX_HANDOFF_CHARS,
  DEFAULT_MAX_HANDOFF_ENTRIES,
  HANDOFF_MARKER,
  type HandoffContext,
  type HandoffEntry,
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

    it("orders sections: reason → recovery → unanswered → interrupted → recent conversation", () => {
      const out = renderHandoff(sample, {
        reason: "hard-cap",
        unanswered: ["queued-question"],
        interruptedTurn: "interrupted-question",
      });
      const reasonAt = out.indexOf("翻页原因");
      const recoveryAt = out.indexOf("恢复指引");
      const unansweredAt = out.indexOf("未答消息");
      const interruptedAt = out.indexOf("最后断点");
      const recentAt = out.indexOf("旧 thread 最近对话");
      expect(reasonAt).toBeGreaterThanOrEqual(0);
      expect(recoveryAt).toBeGreaterThan(reasonAt);
      expect(unansweredAt).toBeGreaterThan(recoveryAt);
      expect(interruptedAt).toBeGreaterThan(unansweredAt);
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
  });
});
