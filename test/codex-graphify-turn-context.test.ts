import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(
  new URL("../scripts/codex-graphify-turn-context.py", import.meta.url),
);

function runHook(input: string) {
  return spawnSync("/usr/bin/python3", [hookPath], {
    input,
    encoding: "utf8",
  });
}

describe("Codex graphify UserPromptSubmit context hook", () => {
  it("injects the shared-graph development contract on every user turn", () => {
    const result = runHook(JSON.stringify({
      session_id: "session-graphify-context",
      turn_id: "turn-graphify-context",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      hook_event_name: "UserPromptSubmit",
      prompt: "Please update the dispatcher.",
      permission_mode: "bypassPermissions",
    }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("canonical shared graph");
    expect(result.stdout).toContain("repo map");
    expect(result.stdout).toContain("affected");
    expect(result.stdout).toContain("private graph");
    expect(result.stdout).toContain("verify");
    expect(result.stderr).toBe("");
  });

  it("fails closed on malformed hook input without injecting partial context", () => {
    const result = runHook("{not-json");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid UserPromptSubmit payload");
  });

  it("rejects a payload for the wrong hook event", () => {
    const result = runHook(JSON.stringify({
      session_id: "session-wrong-event",
      turn_id: "turn-wrong-event",
      cwd: "/tmp",
      hook_event_name: "SessionStart",
      prompt: "hello",
      permission_mode: "default",
    }));

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("expected UserPromptSubmit");
  });
});
