import { describe, expect, it } from "vitest";

import { HANDOFF_MARKER } from "../src/handoff-buffer.js";
import {
  type RotationConfig,
  emptyChatState,
  recordInterruptedTurn,
  recordTurn,
  takeRotationHandoff,
} from "../src/thread-rotation.js";

const cfg: RotationConfig = { enabled: true, threshold: 0.45, contextWindow: 258400 };
const cappedCfg: RotationConfig = { ...cfg, hardCap: 0.6 };
const HEAVY = 130000; // 130000/258400 ≈ 0.50 ≥ 0.45 → rotate
const LIGHT = 40000; //  40000/258400 ≈ 0.15 → no rotate
const OVER_CAP = 160000; // 160000/258400 ≈ 0.62 ≥ 0.60 → mandatory

describe("thread-rotation", () => {
  it("starts empty", () => {
    expect(emptyChatState()).toEqual({ buffer: [], pendingRotation: false });
  });

  describe("recordTurn", () => {
    it("buffers the user message and the assistant reply", () => {
      const s = recordTurn(emptyChatState(), { userText: "修一下部署脚本", assistantText: "好，开修" }, cfg);
      expect(s.buffer).toEqual([
        { role: "user", text: "修一下部署脚本" },
        { role: "assistant", text: "好，开修" },
      ]);
    });

    it("buffers only the user message when the turn produced no reply (timeout)", () => {
      const s = recordTurn(emptyChatState(), { userText: "在吗", assistantText: "" }, cfg);
      expect(s.buffer).toEqual([{ role: "user", text: "在吗" }]);
    });

    it("flags rotation for next turn once the last turn was heavy", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: HEAVY }, cfg);
      expect(s.pendingRotation).toBe(true);
    });

    it("does not flag rotation while turns stay light", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: LIGHT }, cfg);
      expect(s.pendingRotation).toBe(false);
    });

    it("never flags rotation when the feature is disabled", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: HEAVY }, {
        ...cfg,
        enabled: false,
      });
      expect(s.pendingRotation).toBe(false);
    });

    it("keeps an already-pending flag sticky even on a later light turn", () => {
      const pending = { buffer: [], pendingRotation: true };
      const s = recordTurn(pending, { userText: "x", assistantText: "y", lastInputTokens: LIGHT }, cfg);
      expect(s.pendingRotation).toBe(true);
    });
  });

  describe("takeRotationHandoff", () => {
    it("returns no handoff when nothing is pending", () => {
      const s = recordTurn(emptyChatState(), { userText: "hi", assistantText: "yo", lastInputTokens: LIGHT }, cfg);
      const out = takeRotationHandoff(s, cfg);
      expect(out.handoff).toBeNull();
      expect(out.state.pendingRotation).toBe(false);
    });

    it("renders a handoff carrying recent context and clears the flag when pending", () => {
      let s = recordTurn(emptyChatState(), { userText: "部署脚本有 bug", assistantText: "我看下" }, cfg);
      s = recordTurn(s, { userText: "继续", assistantText: "修好了", lastInputTokens: HEAVY }, cfg);
      expect(s.pendingRotation).toBe(true);

      const out = takeRotationHandoff(s, cfg);
      expect(out.handoff).toContain(HANDOFF_MARKER);
      expect(out.handoff).toContain("部署脚本有 bug");
      expect(out.handoff).toContain("修好了");
      expect(out.state.pendingRotation).toBe(false);
      // buffer is preserved so the NEXT handoff still has rolling context
      expect(out.state.buffer.length).toBeGreaterThan(0);
    });

    it("is idempotent — a second take after clearing yields nothing", () => {
      let s = recordTurn(emptyChatState(), { userText: "a", assistantText: "b", lastInputTokens: HEAVY }, cfg);
      const first = takeRotationHandoff(s, cfg);
      expect(first.handoff).not.toBeNull();
      const second = takeRotationHandoff(first.state, cfg);
      expect(second.handoff).toBeNull();
    });

    it("never hands off when the feature is disabled, even if a stale flag is set", () => {
      const stale = { buffer: [{ role: "user" as const, text: "x" }], pendingRotation: true };
      const out = takeRotationHandoff(stale, { ...cfg, enabled: false });
      expect(out.handoff).toBeNull();
    });
  });

  describe("hard-cap mandatory rotation (ALB-1205)", () => {
    it("marks the pending rotation mandatory once a turn crosses the hard cap", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: OVER_CAP }, cappedCfg);
      expect(s.pendingRotation).toBe(true);
      expect(s.pendingMandatory).toBe(true);
    });

    it("keeps a threshold-only crossing non-mandatory", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: HEAVY }, cappedCfg);
      expect(s.pendingRotation).toBe(true);
      expect(s.pendingMandatory).toBeFalsy();
    });

    it("keeps mandatory sticky across later light turns until consumed", () => {
      let s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: OVER_CAP }, cappedCfg);
      s = recordTurn(s, { userText: "轻活", assistantText: "ok", lastInputTokens: LIGHT }, cappedCfg);
      expect(s.pendingMandatory).toBe(true);
    });

    it("never marks mandatory when the hard cap is disabled or not above the threshold", () => {
      const noCap = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: OVER_CAP }, cfg);
      expect(noCap.pendingMandatory).toBeFalsy();
      const badCap = recordTurn(
        emptyChatState(),
        { userText: "x", assistantText: "y", lastInputTokens: OVER_CAP },
        { ...cfg, hardCap: 0.4 },
      );
      expect(badCap.pendingMandatory).toBeFalsy();
      expect(badCap.pendingRotation).toBe(true); // regular threshold flip is unaffected
    });

    it("never marks mandatory when the feature is disabled", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: OVER_CAP }, {
        ...cappedCfg,
        enabled: false,
      });
      expect(s.pendingMandatory).toBeFalsy();
      expect(s.pendingRotation).toBe(false);
    });

    it("reports mandatory from takeRotationHandoff and clears it on consumption", () => {
      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: OVER_CAP }, cappedCfg);
      const out = takeRotationHandoff(s, cappedCfg);
      expect(out.handoff).toContain(HANDOFF_MARKER);
      expect(out.mandatory).toBe(true);
      expect(out.state.pendingRotation).toBe(false);
      expect(out.state.pendingMandatory).toBeFalsy();
    });

    it("renders the hard-cap reason into the mandatory handoff", () => {
      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: OVER_CAP }, cappedCfg);
      const out = takeRotationHandoff(s, cappedCfg);
      expect(out.handoff).toContain("硬上限");
    });

    it("reports mandatory=false on the plain threshold path", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: HEAVY }, cappedCfg);
      const out = takeRotationHandoff(s, cappedCfg);
      expect(out.mandatory).toBe(false);
    });
  });

  describe("lastKnownRatio tracking (ALB-1205)", () => {
    it("records the fill ratio of the last turn that reported usage", () => {
      const s = recordTurn(emptyChatState(), { userText: "x", assistantText: "y", lastInputTokens: HEAVY }, cfg);
      expect(s.lastKnownRatio).toBeCloseTo(130000 / 258400, 5);
    });

    it("keeps the previous ratio when a turn reports no usage", () => {
      let s = recordTurn(emptyChatState(), { userText: "a", assistantText: "b", lastInputTokens: HEAVY }, cfg);
      s = recordTurn(s, { userText: "c", assistantText: "" }, cfg);
      expect(s.lastKnownRatio).toBeCloseTo(130000 / 258400, 5);
    });

    it("stays undefined before any usage has been seen", () => {
      const s = recordTurn(emptyChatState(), { userText: "a", assistantText: "b" }, cfg);
      expect(s.lastKnownRatio).toBeUndefined();
    });
  });

  describe("recordInterruptedTurn (ALB-1205)", () => {
    it("flags a rotation and remembers the interrupted user text when the last known ratio is heavy", () => {
      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: HEAVY }, cfg);
      const consumed = takeRotationHandoff(s, cfg).state; // pending consumed, ratio survives
      const out = recordInterruptedTurn(consumed, "这条被超时打断了", cfg);
      expect(out.pendingRotation).toBe(true);
      expect(out.interruptedTurn).toBe("这条被超时打断了");
    });

    it("does nothing while the last known ratio is light", () => {
      const s = recordTurn(emptyChatState(), { userText: "轻活", assistantText: "ok", lastInputTokens: LIGHT }, cfg);
      const out = recordInterruptedTurn(s, "被打断", cfg);
      expect(out.pendingRotation).toBe(false);
      expect(out.interruptedTurn).toBeUndefined();
    });

    it("does nothing before any ratio is known or when the feature is disabled", () => {
      const cold = recordInterruptedTurn(emptyChatState(), "被打断", cfg);
      expect(cold.pendingRotation).toBe(false);

      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: HEAVY }, cfg);
      const disabled = recordInterruptedTurn(s, "被打断", { ...cfg, enabled: false });
      expect(disabled.interruptedTurn).toBeUndefined();
    });

    it("carries the interrupted turn into the handoff and clears it on consumption", () => {
      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: HEAVY }, cfg);
      const interrupted = recordInterruptedTurn(takeRotationHandoff(s, cfg).state, "把设计稿写完", cfg);
      const out = takeRotationHandoff(interrupted, cfg);
      expect(out.handoff).toContain("最后断点");
      expect(out.handoff).toContain("把设计稿写完");
      expect(out.interruptedTurn).toBe("把设计稿写完");
      expect(out.state.interruptedTurn).toBeUndefined();
      expect(out.state.pendingRotation).toBe(false);
    });
  });

  describe("Linear control-plane extraction", () => {
    it("collects stable refs from recent, unanswered, and interrupted sources", () => {
      const state = {
        buffer: [
          { role: "user" as const, text: "主单 ALB-1201" },
          { role: "assistant" as const, text: "子单 alb-958，重复 ALB-1201" },
        ],
        pendingRotation: true,
        interruptedTurn: "最后断点 ALB-1350",
      };
      const out = takeRotationHandoff(state, cfg, { unanswered: ["排队 ALB-1208"] });
      expect(out.handoff).toContain("--- Linear 在途控制面 ---");
      expect(out.handoff).toContain("ALB-1201, ALB-958, ALB-1208, ALB-1350");
      const control = out.handoff?.split("\n").find((line) => line.startsWith("- refs:")) ?? "";
      expect(control.match(/ALB-1201/g)).toHaveLength(1);
    });
  });

  describe("unanswered snapshot pass-through (ALB-1205)", () => {
    it("renders caller-provided unanswered messages into the handoff", () => {
      const s = recordTurn(emptyChatState(), { userText: "重活", assistantText: "ok", lastInputTokens: HEAVY }, cfg);
      const out = takeRotationHandoff(s, cfg, { unanswered: ["排队的一条", "排队的另一条"] });
      expect(out.handoff).toContain("未答消息");
      expect(out.handoff).toContain("排队的一条");
      expect(out.handoff).toContain("排队的另一条");
    });
  });
});
