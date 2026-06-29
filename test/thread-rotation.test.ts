import { describe, expect, it } from "vitest";

import { HANDOFF_MARKER } from "../src/handoff-buffer.js";
import {
  type RotationConfig,
  emptyChatState,
  recordTurn,
  takeRotationHandoff,
} from "../src/thread-rotation.js";

const cfg: RotationConfig = { enabled: true, threshold: 0.45, contextWindow: 258400 };
const HEAVY = 130000; // 130000/258400 ≈ 0.50 ≥ 0.45 → rotate
const LIGHT = 40000; //  40000/258400 ≈ 0.15 → no rotate

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
});
