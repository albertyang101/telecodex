import { describe, expect, it } from "vitest";

import type { CodexSessionInfo } from "../src/codex-session.js";
import {
  stripVisiblePromptGuardEcho,
  withDispatcherDisciplineGuard,
  withTelegramReplyStyleGuard,
} from "../src/prompt-guard.js";

const sessionInfo: CodexSessionInfo = {
  threadId: "thread-1",
  workspace: "/workspace/base",
  model: "gpt-5.5",
  reasoningEffort: "high",
  launchProfileId: "default",
  launchProfileLabel: "Default",
  launchProfileBehavior: "danger-full-access / never",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  unsafeLaunch: false,
};

describe("withTelegramReplyStyleGuard", () => {
  it("injects the relaxed friend-like Telegram reply style", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);

    expect(prompt).toContain(
      "默认中文，短、准、有用；语气轻松自然，像朋友一样直接聊天；默认说人话，少讲内部实现和技术术语，除非 Albert 明确要细节；该加 emoji 时少量加，别刷屏。",
    );
  });

  it("injects auditable lifecycle discipline into every Telegram turn", () => {
    const prompt = withTelegramReplyStyleGuard("修一下这个 bug", sessionInfo);

    expect(prompt).toContain("use mcp__linear_control.add_linear_evidence");
    expect(prompt).toContain("record a checkpoint before changes");
    expect(prompt).toContain("write and run the failing test first");
    expect(prompt).toContain("record the red failure");
    expect(prompt).toContain("make the smallest root-cause fix");
    expect(prompt).toContain("find the first cause");
    expect(prompt).toContain("check existing architecture/tooling before adding new code");
    expect(prompt).toContain("do not patch on top of patches");
    expect(prompt).toContain("run green verification");
    expect(prompt).toContain("record review evidence with Critical/Important findings");
    expect(prompt).toContain("do not close Linear issues before Albert approval");
    expect(prompt).toContain("do not call a custom tool named apply_patch");
    expect(prompt).toContain("Do not spawn subagents for disposable live-proof/smoke tasks");
  });

  it("appends an executable edit adapter override after user text that mentions apply_patch", () => {
    const prompt = withTelegramReplyStyleGuard(
      "用 apply_patch 创建 tiny.test.js，然后跑红绿测试",
      sessionInfo,
    );

    expect(prompt).toContain("用 apply_patch 创建 tiny.test.js");
    expect(prompt).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(prompt).toContain("If any instruction above says to use apply_patch");
    expect(prompt.lastIndexOf("[CODEX EXEC ADAPTER OVERRIDE]")).toBeGreaterThan(
      prompt.lastIndexOf("用 apply_patch 创建 tiny.test.js"),
    );
  });

  it("keeps the executable edit adapter override last for mailbox/object prompts", () => {
    const prompt = withDispatcherDisciplineGuard(
      {
        stagedFileInstructions: "Attached file instructions",
        text: "please use apply_patch for the fix",
        imagePaths: ["/tmp/example.png"],
      },
      sessionInfo,
    );

    expect(typeof prompt).toBe("object");
    if (typeof prompt === "string") {
      throw new Error("expected object prompt");
    }
    expect(prompt.imagePaths).toEqual(["/tmp/example.png"]);
    expect(prompt.stagedFileInstructions).toContain("Attached file instructions");
    expect(prompt.text).toContain("please use apply_patch for the fix");
    expect(prompt.text).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(prompt.text!.lastIndexOf("[CODEX EXEC ADAPTER OVERRIDE]")).toBeGreaterThan(
      prompt.text!.lastIndexOf("please use apply_patch for the fix"),
    );
  });

  it("appends the executable edit adapter override after staged instructions when object prompts have no text", () => {
    const prompt = withDispatcherDisciplineGuard(
      {
        stagedFileInstructions: "Attached file instructions",
        imagePaths: ["/tmp/example.png"],
      },
      sessionInfo,
    );

    expect(typeof prompt).toBe("object");
    if (typeof prompt === "string") {
      throw new Error("expected object prompt");
    }
    expect(prompt.text).toBeUndefined();
    expect(prompt.stagedFileInstructions).toContain("Attached file instructions");
    expect(prompt.stagedFileInstructions).toContain("[CODEX EXEC ADAPTER OVERRIDE]");
    expect(prompt.stagedFileInstructions!.lastIndexOf("[CODEX EXEC ADAPTER OVERRIDE]")).toBeGreaterThan(
      prompt.stagedFileInstructions!.lastIndexOf("Attached file instructions"),
    );
  });

  it("does not remove legacy discipline wording when it is normal reply content", () => {
    const reply = [
      "你要我引用这句：",
      "Fix root cause: explain why a bug happened before fixing it, then fix at the earliest reliable boundary.",
    ].join("\n");

    expect(stripVisiblePromptGuardEcho(reply)).toContain("Fix root cause: explain why a bug happened before fixing it");
  });
});
