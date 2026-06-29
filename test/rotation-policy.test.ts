import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_ROTATE_THRESHOLD,
  contextFillRatio,
  resolveContextWindow,
  shouldRotate,
} from "../src/rotation-policy.js";

describe("rotation-policy", () => {
  describe("resolveContextWindow", () => {
    it("uses model_context_window from token_count info when present", () => {
      expect(resolveContextWindow({ model_context_window: 258400 })).toBe(258400);
    });

    it("falls back to the provided fallback when info is missing", () => {
      expect(resolveContextWindow(undefined, 200000)).toBe(200000);
    });

    it("falls back to DEFAULT_CONTEXT_WINDOW when info and fallback are both absent", () => {
      expect(resolveContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it("ignores a zero/negative/non-finite info window and uses fallback", () => {
      expect(resolveContextWindow({ model_context_window: 0 }, 123456)).toBe(123456);
      expect(resolveContextWindow({ model_context_window: -5 }, 123456)).toBe(123456);
      expect(resolveContextWindow({ model_context_window: Number.NaN }, 123456)).toBe(123456);
    });
  });

  describe("contextFillRatio", () => {
    it("computes lastInputTokens / contextWindow", () => {
      expect(contextFillRatio(129200, 258400)).toBeCloseTo(0.5, 5);
    });

    it("returns 0 for a non-positive window (unknown context size)", () => {
      expect(contextFillRatio(1000, 0)).toBe(0);
    });

    it("returns 0 when no input tokens have been seen yet", () => {
      expect(contextFillRatio(0, 258400)).toBe(0);
    });
  });

  describe("shouldRotate", () => {
    it("rotates once the fill ratio reaches the threshold", () => {
      expect(shouldRotate({ lastInputTokens: 130000, contextWindow: 258400, threshold: 0.45 })).toBe(true);
    });

    it("does not rotate while the fill ratio is below the threshold", () => {
      expect(shouldRotate({ lastInputTokens: 50000, contextWindow: 258400, threshold: 0.45 })).toBe(false);
    });

    it("rotates exactly at the threshold (>= semantics, matching CC)", () => {
      expect(shouldRotate({ lastInputTokens: 129200, contextWindow: 258400, threshold: 0.5 })).toBe(true);
    });

    it("never rotates when the context window is unknown/zero", () => {
      expect(shouldRotate({ lastInputTokens: 999999, contextWindow: 0, threshold: 0.45 })).toBe(false);
    });

    it("never rotates before any input tokens have been recorded", () => {
      expect(shouldRotate({ lastInputTokens: 0, contextWindow: 258400, threshold: 0.45 })).toBe(false);
    });

    it("treats a misconfigured threshold (<=0 or >1) as rotation disabled", () => {
      // A 0 threshold would otherwise rotate every single turn; a 45 (meant 0.45)
      // would silently never fire. Both should fail safe to "do not rotate".
      expect(shouldRotate({ lastInputTokens: 250000, contextWindow: 258400, threshold: 0 })).toBe(false);
      expect(shouldRotate({ lastInputTokens: 250000, contextWindow: 258400, threshold: 45 })).toBe(false);
    });
  });

  describe("defaults", () => {
    it("ships a sane in-range rotate threshold and the gpt-5.5 window", () => {
      expect(DEFAULT_ROTATE_THRESHOLD).toBeGreaterThan(0);
      expect(DEFAULT_ROTATE_THRESHOLD).toBeLessThan(1);
      expect(DEFAULT_CONTEXT_WINDOW).toBe(258400);
    });
  });
});
