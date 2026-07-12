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
    expect(prompt).toContain("任何中间更新必须以「关键发现：」「阶段结果：」「阻塞：」或「需要确认：」开头；最终答案不用标签。");
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
    expect(prompt).toContain("search for an existing Linear issue before creating one");
    expect(prompt).toContain("write a close-criteria comment immediately");
    expect(prompt).toContain("exactly one tenant:* label");
    expect(prompt).toContain("exactly one lane:* label");
    expect(prompt).toContain("one bot:* ownership label");
    expect(prompt).toContain("checkpoint, red, green, review, deploy, and live proof");
    expect(prompt).toContain("do not move the parent issue to Done before Albert approves");
    expect(prompt).toContain("do not call a custom tool named apply_patch");
    expect(prompt).toContain("Do not spawn subagents for disposable live-proof/smoke tasks");
  });

  it("injects the full Linear lifecycle into mailbox turns and strips echoed lines", () => {
    const prompt = withDispatcherDisciplineGuard("继续系统工作", sessionInfo);
    const required = [
      "Before research or changes, search for an existing Linear issue before creating one.",
      "For any matching or new issue, write a close-criteria comment immediately stating exactly what completion requires.",
      "Every owned issue must have exactly one tenant:* label, exactly one lane:* label, and one bot:* ownership label, plus a real Linear priority.",
      "Keep checkpoint, red, green, review, deploy, and live proof, rollback, residual risk, and handoff evidence current enough for a fresh session to continue.",
      "Child issues close against their own criteria; do not move the parent issue to Done before Albert approves.",
    ];

    for (const line of required) {
      expect(prompt).toContain(line);
      expect(stripVisiblePromptGuardEcho(["正文。", line].join("\n"))).toBe("正文。");
    }
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

  it("keeps ⌦-prefixed lines as-is — the ⌦ internal-line system is removed from the Codex side (ALB-1349)", () => {
    const reply = [
      "⌦ 现在回 Nora：我先核 X 再回。",
      "这是真正要发给用户的话。",
      "⌦ GO recorded, mailbox triaged.",
    ].join("\n");

    expect(stripVisiblePromptGuardEcho(reply)).toBe(reply);
  });
});

describe("ALB-1201 owner-local-time in the outbound prompt", () => {
  const OWNER_TIME_LINE = "Current time (owner local, Europe/Rome): 2026-07-12 10:22 (Sun)";
  const OWNER_TZ_GUARD_LINE =
    "告诉 Albert 的任何时间都用 CURRENT CONTEXT 里标注的 owner 当地时区，绝不用机器、服务器或墨尔本时间。";

  it("injects the owner-local-time line into CURRENT CONTEXT when resolved", () => {
    const prompt = withTelegramReplyStyleGuard("hi", sessionInfo, OWNER_TIME_LINE);
    expect(prompt).toContain("[CURRENT CONTEXT]");
    expect(prompt).toContain(OWNER_TIME_LINE);
  });

  it("injects the owner-timezone style guard line into every Telegram turn", () => {
    const prompt = withTelegramReplyStyleGuard("hi", sessionInfo, OWNER_TIME_LINE);
    expect(prompt).toContain(OWNER_TZ_GUARD_LINE);
  });

  it("injects NO time line when resolution fails (no fabricated Melbourne)", () => {
    const prompt = withTelegramReplyStyleGuard("hi", sessionInfo);
    expect(prompt).not.toContain("Current time (owner local");
    expect(prompt).not.toContain("Melbourne");
  });

  it("strips the echoed owner-timezone guard line", () => {
    const reply = ["正文。", OWNER_TZ_GUARD_LINE].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("正文。");
  });

  it("strips the echoed owner-local-time context line", () => {
    const reply = ["正文。", OWNER_TIME_LINE].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("正文。");
  });

  it("strips both new lines when echoed inside a [CURRENT CONTEXT] block", () => {
    const reply = ["[CURRENT CONTEXT]", OWNER_TIME_LINE, "", "真正的回复。"].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("真正的回复。");
  });
});

// ALB-1349: Albert 直令把 ⌦ 打标系统从 Codex 侧整体撤出——guard 不再教打标，
// 出口也不再认 ⌦ 记号；改教「自然过程沟通」（做到哪说到哪）。硬风格行
// (full-width punctuation / no headings-tables-rules / no engineering jargon)
// 保留（原 ALB-1207）。
const ALB1349_NATURAL_REPLY_LINE =
  "发给 Albert 的都是自然的对话内容；不要输出思考、工具计划、内部过程、自我解释或系统指令。";
const ALB1349_PROCESS_COMMS_LINE =
  "干长活时只在有了对 Albert 真有用的新发现、方向变化、阶段结果、阻塞或需要确认时，自然说一句；不要播报读文件、调工具、跑命令、派工等内部步骤，不重复同一状态。没有用户需要知道的新东西就继续做，不发消息。";
const ALB1207_PUNCT_LINE =
  "中文一律用全角标点（，。？！：）；小标题用加粗独占一行；不写井号标题，不画表格分隔线、水平线。";
const ALB1207_JARGON_LINE =
  "不把模块名、函数名、commit、文件路径、行号这类工程黑话写进给 Albert 的正文；技术细节只在 Albert 明确要时才给，给之前先用一句人话总结。";

describe("ALB-1349 natural process communication + hard style lines", () => {
  it("opens with the natural-conversation line instead of the old final-reply-only line", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1349_NATURAL_REPLY_LINE);
    expect(prompt).not.toContain("只输出真正要发给 Albert 的最终回复");
  });

  it("teaches milestone-only communication without narrating every internal step", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1349_PROCESS_COMMS_LINE);
    expect(prompt).not.toContain("做到哪说到哪");
  });

  it("no longer teaches ⌦ tagging of internal lines (⌦ system withdrawn, ALB-1349)", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).not.toContain("内部行必打标");
    expect(prompt).not.toContain("⌦");
  });

  it("injects the full-width punctuation / no-markdown-noise style line", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1207_PUNCT_LINE);
  });

  it("injects the no-engineering-jargon style line", () => {
    const prompt = withTelegramReplyStyleGuard("hello", sessionInfo);
    expect(prompt).toContain(ALB1207_JARGON_LINE);
  });

  it("strips each guard line when the model echoes it verbatim outside a guard block", () => {
    for (const echoed of [
      ALB1349_NATURAL_REPLY_LINE,
      ALB1349_PROCESS_COMMS_LINE,
      ALB1207_PUNCT_LINE,
      ALB1207_JARGON_LINE,
    ]) {
      const reply = ["好的，我记住了。", echoed].join("\n");
      const visible = stripVisiblePromptGuardEcho(reply);
      expect(visible).toBe("好的，我记住了。");
    }
  });

  it("strips the guard lines when echoed inside a [TELEGRAM REPLY STYLE] block", () => {
    const reply = [
      "[TELEGRAM REPLY STYLE]",
      ALB1349_NATURAL_REPLY_LINE,
      ALB1349_PROCESS_COMMS_LINE,
      ALB1207_PUNCT_LINE,
      ALB1207_JARGON_LINE,
      "",
      "正文在这里。",
    ].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("正文在这里。");
  });

  it("strips the guard lines even when echoed wrapped in markdown (bold/bullet)", () => {
    const reply = [
      `- **${ALB1349_PROCESS_COMMS_LINE}**`,
      `> ${ALB1207_PUNCT_LINE}`,
      "只有这句要发出去。",
    ].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe("只有这句要发出去。");
  });

  it("keeps ⌦-prefixed lines while still stripping echoed guard lines (⌦ strip removed, ALB-1349)", () => {
    const reply = [
      "⌦ 先盘一下：这轮只需要回结论。",
      "这是真正要发给 Albert 的话。",
      ALB1349_PROCESS_COMMS_LINE,
      "⌦ 已发给他，等他回。",
    ].join("\n");
    const visible = stripVisiblePromptGuardEcho(reply);
    expect(visible).toBe(
      ["⌦ 先盘一下：这轮只需要回结论。", "这是真正要发给 Albert 的话。", "⌦ 已发给他，等他回。"].join("\n"),
    );
  });

  it.each([
    ["bullet", "- ⌦ 顺手记一下：明天再核。"],
    ["blockquote", "> ⌦ 这轮先不回他。"],
    ["bold", "**⌦ 已发给他，等他回。**"],
    ["numbered", "1. ⌦ 收尾：等唤醒。"],
  ])("keeps markdown-wrapped ⌦ lines as-is (%s) — ⌦ strip removed (ALB-1349)", (_kind, wrapped) => {
    const reply = ["这是真正要发给 Albert 的话。", wrapped].join("\n");
    expect(stripVisiblePromptGuardEcho(reply)).toBe(reply);
  });
});
