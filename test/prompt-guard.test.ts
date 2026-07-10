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

  it("strips whole lines that begin with the ⌦ internal-line marker (ALB-1206), keeping normal lines", () => {
    const reply = [
      "⌦ 现在回 Nora：我先核 X 再回。",
      "这是真正要发给用户的话。",
      "⌦ GO recorded, mailbox triaged.",
    ].join("\n");

    const visible = stripVisiblePromptGuardEcho(reply);
    expect(visible).toBe("这是真正要发给用户的话。");
    expect(visible).not.toContain("⌦");
    expect(visible).not.toContain("Nora");
    expect(visible).not.toContain("GO recorded");
  });

  it("returns empty when every line is ⌦-marked (whole message is internal, ALB-1206)", () => {
    const reply = ["⌦ 都处理完了。", "⌦ 球在他那，等他回。"].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("");
  });
});

// ALB-1207 W2: the guard must TEACH the model to tag internal lines with ⌦
// (the outbound strip already exists but was idle without this teaching line),
// plus hard style rules (full-width punctuation / no headings-tables-rules /
// no engineering jargon in Albert-facing prose).
const ALB1207_TAGGING_LINE =
  "内部行必打标：凡说给自己的行（盘算、进度自述、干活旁白、收尾复述如「已发给他/等他回」），行首打「⌦ 」，出口会机械剥掉；给 Albert 的话绝不打标；后台轮没有要对用户说的话，就整条全部打标或直接留空。";
const ALB1207_PUNCT_LINE =
  "中文一律用全角标点（，。？！：）；小标题用加粗独占一行；不写井号标题，不画表格分隔线、水平线。";
const ALB1207_JARGON_LINE =
  "不把模块名、函数名、commit、文件路径、行号这类工程黑话写进给 Albert 的正文；技术细节只在 Albert 明确要时才给，给之前先用一句人话总结。";

describe("ALB-1207 guard tagging teaching + hard style lines", () => {
  it("teaches ⌦ tagging of internal lines in every Telegram turn", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1207_TAGGING_LINE);
  });

  it("injects the full-width punctuation / no-markdown-noise style line", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1207_PUNCT_LINE);
  });

  it("injects the no-engineering-jargon style line", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1207_JARGON_LINE);
  });

  it("strips each new guard line when the model echoes it verbatim outside a guard block", () => {
    for (const echoed of [ALB1207_TAGGING_LINE, ALB1207_PUNCT_LINE, ALB1207_JARGON_LINE]) {
      const reply = ["好的，我记住了。", echoed].join("\n");
      const visible = stripVisiblePromptGuardEcho(reply);
      expect(visible).toBe("好的，我记住了。");
    }
  });

  it("strips the new guard lines when echoed inside a [TELEGRAM REPLY STYLE] block", () => {
    const reply = [
      "[TELEGRAM REPLY STYLE]",
      ALB1207_TAGGING_LINE,
      ALB1207_PUNCT_LINE,
      ALB1207_JARGON_LINE,
      "",
      "正文在这里。",
    ].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("正文在这里。");
  });

  it("strips the new guard lines even when echoed wrapped in markdown (bold/bullet)", () => {
    const reply = [
      `- **${ALB1207_TAGGING_LINE}**`,
      `> ${ALB1207_PUNCT_LINE}`,
      "只有这句要发出去。",
    ].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("只有这句要发出去。");
  });

  it("keeps only the normal line when ⌦ internal lines, normal text and echoed guard lines coexist", () => {
    const reply = [
      "⌦ 先盘一下：这轮只需要回结论。",
      "这是真正要发给 Albert 的话。",
      ALB1207_TAGGING_LINE,
      "⌦ 已发给他，等他回。",
    ].join("\n");
    const visible = stripVisiblePromptGuardEcho(reply);
    expect(visible).toBe("这是真正要发给 Albert 的话。");
    expect(visible).not.toContain("⌦");
    expect(visible).not.toContain("内部行必打标");
  });
});
