import { describe, expect, it, vi } from "vitest";

import { settleQueuedPromptCleanup } from "../src/queued-prompt-cleanup.js";

describe("settleQueuedPromptCleanup", () => {
  it("isolates a cleanup failure so the next queued item runs and every typing lease releases", async () => {
    const events: string[] = [];
    const reportError = vi.fn();

    for (const [index, cleanup] of [
      async () => {
        events.push("cleanup-1");
        throw new Error("cleanup failed");
      },
      async () => {
        events.push("cleanup-2");
      },
    ].entries()) {
      await settleQueuedPromptCleanup(
        cleanup,
        () => events.push("release-" + String(index + 1)),
        reportError,
      );
      events.push("continued-" + String(index + 1));
    }

    expect(events).toEqual([
      "cleanup-1",
      "release-1",
      "continued-1",
      "cleanup-2",
      "release-2",
      "continued-2",
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0]?.[0])).toContain("cleanup failed");
  });
});
