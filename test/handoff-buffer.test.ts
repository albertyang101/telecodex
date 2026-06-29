import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ENTRY_CHARS,
  DEFAULT_MAX_HANDOFF_CHARS,
  DEFAULT_MAX_HANDOFF_ENTRIES,
  HANDOFF_MARKER,
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

  describe("defaults", () => {
    it("exports sane bounds", () => {
      expect(DEFAULT_MAX_HANDOFF_ENTRIES).toBeGreaterThan(0);
      expect(DEFAULT_MAX_ENTRY_CHARS).toBeGreaterThan(0);
      expect(DEFAULT_MAX_HANDOFF_CHARS).toBeGreaterThan(DEFAULT_MAX_ENTRY_CHARS);
    });
  });
});
