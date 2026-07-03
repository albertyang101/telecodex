import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_ROTATE_HARD_CAP,
  DEFAULT_ROTATE_THRESHOLD,
  contextFillRatio,
  resolveContextWindow,
  resolveHardCap,
  shouldForceRotate,
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

  describe("resolveHardCap (ALB-1205)", () => {
    it("accepts a valid hard cap strictly above the threshold", () => {
      expect(resolveHardCap(0.6, 0.45)).toBe(0.6);
      expect(resolveHardCap(1, 0.45)).toBe(1);
    });

    it("disables the hard cap on any non-finite / out-of-range value", () => {
      expect(resolveHardCap(Number.NaN, 0.45)).toBeUndefined();
      expect(resolveHardCap(Number.POSITIVE_INFINITY, 0.45)).toBeUndefined();
      expect(resolveHardCap(0, 0.45)).toBeUndefined();
      expect(resolveHardCap(-0.6, 0.45)).toBeUndefined();
      expect(resolveHardCap(1.5, 0.45)).toBeUndefined();
      expect(resolveHardCap("0.6", 0.45)).toBeUndefined();
      expect(resolveHardCap(undefined, 0.45)).toBeUndefined();
    });

    it("disables the hard cap when it is not strictly above the rotate threshold", () => {
      expect(resolveHardCap(0.45, 0.45)).toBeUndefined();
      expect(resolveHardCap(0.4, 0.45)).toBeUndefined();
    });
  });

  describe("shouldForceRotate (ALB-1205)", () => {
    it("forces rotation once the fill ratio reaches the hard cap", () => {
      expect(
        shouldForceRotate({ lastInputTokens: 160000, contextWindow: 258400, threshold: 0.45, hardCap: 0.6 }),
      ).toBe(true);
    });

    it("does not force rotation between the threshold and the hard cap", () => {
      expect(
        shouldForceRotate({ lastInputTokens: 130000, contextWindow: 258400, threshold: 0.45, hardCap: 0.6 }),
      ).toBe(false);
    });

    it("fails safe to false when the hard cap is disabled or misconfigured", () => {
      expect(
        shouldForceRotate({ lastInputTokens: 250000, contextWindow: 258400, threshold: 0.45, hardCap: undefined }),
      ).toBe(false);
      expect(
        shouldForceRotate({ lastInputTokens: 250000, contextWindow: 258400, threshold: 0.45, hardCap: 1.5 }),
      ).toBe(false);
      expect(
        shouldForceRotate({ lastInputTokens: 250000, contextWindow: 258400, threshold: 0.7, hardCap: 0.6 }),
      ).toBe(false);
    });

    it("never force-rotates when the context window is unknown/zero", () => {
      expect(
        shouldForceRotate({ lastInputTokens: 999999, contextWindow: 0, threshold: 0.45, hardCap: 0.6 }),
      ).toBe(false);
    });
  });

  describe("defaults", () => {
    it("ships a sane in-range rotate threshold and the gpt-5.5 window", () => {
      expect(DEFAULT_ROTATE_THRESHOLD).toBeGreaterThan(0);
      expect(DEFAULT_ROTATE_THRESHOLD).toBeLessThan(1);
      expect(DEFAULT_CONTEXT_WINDOW).toBe(258400);
    });

    it("ships the 0.60 hard cap default above the rotate threshold (ALB-1205)", () => {
      expect(DEFAULT_ROTATE_HARD_CAP).toBe(0.6);
      expect(DEFAULT_ROTATE_HARD_CAP).toBeGreaterThan(DEFAULT_ROTATE_THRESHOLD);
    });
  });
});
