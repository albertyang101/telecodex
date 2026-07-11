import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(new URL("../scripts/codex-core-discipline-turn-context.py", import.meta.url));

describe("Codex core discipline turn context", () => {
  it("injects Linear lifecycle and HANDOFF recovery on every user turn", () => {
    const result = spawnSync("/usr/bin/python3", [hookPath], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const context = payload.hookSpecificOutput.additionalContext;
    expect(context).toContain("search Linear before creating an issue");
    expect(context).toContain("close criteria");
    expect(context).toContain("tenant, lane, and bot ownership labels");
    expect(context).toContain("HANDOFF");
    expect(context).toContain("issue/comments/status/close criteria");
    expect(context).not.toContain("persona_memory");
    expect(context).not.toContain("Graphiti");
  });

  it("fails closed on a non-UserPromptSubmit event", () => {
    const result = spawnSync("/usr/bin/python3", [hookPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse" }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  });
});
