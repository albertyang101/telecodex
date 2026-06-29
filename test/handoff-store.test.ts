import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { clearChatState, handoffStatePath, loadChatState, saveChatState } from "../src/handoff-store.js";
import { emptyChatState } from "../src/thread-rotation.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "telecodex-handoff-store-"));
}

describe("handoff-store", () => {
  describe("handoffStatePath", () => {
    it("sanitizes context keys that are unsafe as filenames", () => {
      const p = handoffStatePath("/state", "mailbox:albert-v3");
      expect(path.dirname(p)).toBe("/state");
      expect(path.basename(p)).not.toContain(":");
      expect(path.basename(p)).toContain("mailbox_albert-v3");
    });

    it("keeps a plain numeric chat id readable", () => {
      expect(path.basename(handoffStatePath("/state", "6872058088"))).toBe("handoff-6872058088.json");
    });
  });

  describe("load / save round-trip", () => {
    it("returns an empty state when nothing has been persisted", () => {
      const dir = tmp();
      try {
        expect(loadChatState(dir, "6872058088")).toEqual(emptyChatState());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("round-trips the buffer and the pending flag", () => {
      const dir = tmp();
      try {
        const state = {
          buffer: [
            { role: "user" as const, text: "修部署脚本" },
            { role: "assistant" as const, text: "好的" },
          ],
          pendingRotation: true,
        };
        saveChatState(dir, "6872058088", state);
        expect(loadChatState(dir, "6872058088")).toEqual(state);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("creates the state directory if it does not exist yet", () => {
      const dir = tmp();
      try {
        const nested = path.join(dir, "deep", ".telecodex");
        saveChatState(nested, "abc", { buffer: [{ role: "user", text: "hi" }], pendingRotation: false });
        expect(loadChatState(nested, "abc").buffer).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to empty state on corrupt JSON instead of throwing", () => {
      const dir = tmp();
      try {
        writeFileSync(handoffStatePath(dir, "x"), "{not valid json", "utf8");
        expect(loadChatState(dir, "x")).toEqual(emptyChatState());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops malformed entries from a persisted buffer", () => {
      const dir = tmp();
      try {
        writeFileSync(
          handoffStatePath(dir, "x"),
          JSON.stringify({
            buffer: [{ role: "user", text: "ok" }, { role: "user" }, { text: "no role" }, 42],
            pendingRotation: false,
          }),
          "utf8",
        );
        expect(loadChatState(dir, "x").buffer).toEqual([{ role: "user", text: "ok" }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes atomically (no leftover .tmp file)", () => {
      const dir = tmp();
      try {
        saveChatState(dir, "x", { buffer: [], pendingRotation: false });
        expect(() => readFileSync(`${handoffStatePath(dir, "x")}.tmp`, "utf8")).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("clears persisted state and any leftover temp file", () => {
      const dir = tmp();
      try {
        saveChatState(dir, "x", { buffer: [{ role: "user", text: "stale" }], pendingRotation: true });
        writeFileSync(handoffStatePath(dir, "x") + ".tmp", "partial", "utf8");

        clearChatState(dir, "x");

        expect(loadChatState(dir, "x")).toEqual(emptyChatState());
        expect(() => readFileSync(handoffStatePath(dir, "x") + ".tmp", "utf8")).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
