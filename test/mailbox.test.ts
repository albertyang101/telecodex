import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
import { runMailboxDeliveryOnce } from "../src/mailbox.js";

describe("mailbox bridge", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-mailbox-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("processes one shared mailbox message and writes the Codex final response back to the sender", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-1",
      subject: "Need Theo ack",
      body: "Please confirm you can hear bot-to-bot mailbox.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-1",
      subject: "Need Theo ack",
      messagePath: inboundPath,
    });

    let promptText = "";
    const session = createSession(async (input, callbacks) => {
      promptText = String(input);
      callbacks.onTextDelta("draft that should not be mailed");
      callbacks.onAgentMessage?.("收到，Theo/Codex 已经接入 bot-to-bot mailbox。");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), registry as never);

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 0 });
    expect(registry.getOrCreate).toHaveBeenCalledWith("mailbox:albert-v3");
    expect(registry.updateMetadata).toHaveBeenCalledWith("mailbox:albert-v3", session);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(promptText).toContain("[cross-persona realtime mailbox]");
    expect(promptText).toContain("from: cody");
    expect(promptText).toContain("to: albert-v3");
    expect(promptText).toContain("The bridge will write your final reply back to the sender mailbox");
    expect(promptText).not.toContain("mcp__persona_memory__");

    expect(existsSync(inboundPath)).toBe(false);
    const archivedInbound = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "albert-v3",
      "archive",
      "2026-06",
      path.basename(inboundPath),
    );
    expect(existsSync(archivedInbound)).toBe(true);
    expect(readFileSync(archivedInbound, "utf8")).toContain("status: read");

    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"));
    expect(replies).toHaveLength(1);
    const replyText = readFileSync(
      path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox", replies[0]!),
      "utf8",
    );
    expect(replyText).toContain("from: albert-v3");
    expect(replyText).toContain("to: cody");
    expect(replyText).toContain("in_reply_to: msg-1");
    expect(replyText).toContain("收到，Theo/Codex 已经接入 bot-to-bot mailbox。");

    expect(
      existsSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_events",
          "albert-v3",
          "archive",
          "2026-06",
          "20260621T000000Z-msg-1.json",
        ),
      ),
    ).toBe(true);
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "msg-1.json",
        ),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      msg_id: "msg-1",
      from: "cody",
      to: "albert-v3",
      status: "processed",
      delivered_by: "telecodex-mailbox-bridge",
      message_path: archivedInbound,
    });
  });

  it("skips historical backlog before MAILBOX_MIN_SENT_AT", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "old-msg",
      subject: "Old backlog",
      body: "This should not be delivered during cutover.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("should not run");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.minSentAt = "2026-06-21T00:00:01Z";

    const result = await runMailboxDeliveryOnce(config, registry as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(registry.getOrCreate).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(existsSync(inboundPath)).toBe(true);
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
    const seen = JSON.parse(
      readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["old-msg"].status).toBe("skipped_before_min_sent_at");
  });

  it("skips compact mailbox timestamps before MAILBOX_MIN_SENT_AT", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "old-compact-msg",
      sentAt: "20260619T043533Z",
      subject: "Old compact backlog",
      body: "This compact timestamp is before the cutover.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("should not run");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.minSentAt = "2026-06-21T06:16:40Z";

    const result = await runMailboxDeliveryOnce(config, registry as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(registry.getOrCreate).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(existsSync(inboundPath)).toBe(true);
    const seen = JSON.parse(
      readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["old-compact-msg"].status).toBe("skipped_before_min_sent_at");
  });

  it("normalizes compact mailbox timestamps for archive months", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "compact-month",
      sentAt: "20260621T001500Z",
      subject: "Compact month",
      body: "Please process this compact timestamp.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "compact-month",
      sentAt: "20260621T001500Z",
      subject: "Compact month",
      messagePath: inboundPath,
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("NO_REPLY");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 0, skipped: 0 });
    expect(
      existsSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "albert-v3",
          "archive",
          "2026-06",
          path.basename(inboundPath),
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_events",
          "albert-v3",
          "archive",
          "2026-06",
          "20260621T001500Z-compact-month.json",
        ),
      ),
    ).toBe(true);
  });

  it("does not auto-reply unless MAILBOX_AUTO_REPLY is explicitly enabled", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-no-auto",
      subject: "No auto reply",
      body: "Process but do not write a reply.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("this should stay internal");
      callbacks.onAgentEnd();
    });
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.autoReply = false;

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 0, skipped: 0 });
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
  });

  it("does not auto-reply to replies", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-reply",
      subject: "Re: prior",
      body: "This is already a reply.",
      inReplyTo: "prior-msg",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("would loop without a guard");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 0, skipped: 0 });
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
  });

  it("treats literal null in_reply_to from the CC mailbox writer as no parent reply", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "null-parent",
      subject: "Null parent",
      body: "This should receive a reply.",
      inReplyTo: "null",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("reply despite literal null");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 0 });
    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"));
    expect(replies).toHaveLength(1);
    expect(readFileSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox", replies[0]!), "utf8")).toContain(
      "reply despite literal null",
    );
  });

  it("ignores misfiled messages whose frontmatter recipient does not match the bridge persona", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      frontmatterRecipient: "albert-v2",
      msgId: "wrong-to",
      subject: "Wrong recipient",
      body: "Should not be processed by Theo.",
    });
    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("wrong persona");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 0 });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(existsSync(inboundPath)).toBe(true);
  });

  it("uses a deterministic reply file so retrying the same message cannot duplicate replies", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const input = {
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "retry-msg",
      subject: "Retry proof",
      body: "Please reply once.",
    };
    const firstInbound = writeMailboxMessage(input);

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("one stable reply");
      callbacks.onAgentEnd();
    });
    await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    writeFileSync(firstInbound, readFileSync(path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "albert-v3",
      "archive",
      "2026-06",
      path.basename(firstInbound),
    ), "utf8").replace("status: read", "status: unread"), "utf8");
    rmSync(path.join(workspace, ".telecodex"), { recursive: true, force: true });

    await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"));
    expect(replies).toHaveLength(1);
  });
});

function createConfig(overrides: { personasRoot: string; workspace: string }): TeleCodexConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: overrides.workspace,
    maxFileSize: 20 * 1024 * 1024,
    codexModel: "gpt-5.5",
    codexSandboxMode: "read-only",
    codexApprovalPolicy: "never",
    launchProfiles: [],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "none",
    streamAgentResponses: false,
    showTurnTokenUsage: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    mailboxBridge: {
      enabled: true,
      persona: "albert-v3",
      personasRoot: overrides.personasRoot,
      contextKey: undefined,
      pollMs: 500,
      fullScanMs: 10_000,
      autoReply: true,
      maxMessagesPerTick: 1,
      minSentAt: undefined,
    },
  };
}

function createSession(onPrompt: (input: unknown, callbacks: CodexSessionCallbacks) => Promise<void>) {
  return {
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    newThread: vi.fn(),
    prompt: vi.fn(async (input: unknown, callbacks: CodexSessionCallbacks) => {
      await onPrompt(input, callbacks);
    }),
    getInfo: vi.fn(() => ({
      threadId: "thread-mailbox",
      workspace: "/workspace/base",
      model: "gpt-5.5",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })),
  };
}

function createRegistry(session: unknown) {
  return {
    getOrCreate: vi.fn(async () => session),
    updateMetadata: vi.fn(),
  };
}

function writeMailboxMessage(input: {
  personasRoot: string;
  sender: string;
  recipient: string;
  msgId: string;
  sentAt?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  frontmatterRecipient?: string;
}): string {
  const inbox = path.join(
    input.personasRoot,
    "_shared",
    "memory",
    "mailbox",
    input.recipient,
    "inbox",
  );
  mkdirRecursive(inbox);
  mkdirRecursive(path.join(input.personasRoot, input.sender));
  mkdirRecursive(path.join(input.personasRoot, input.recipient));
  const sentAt = input.sentAt ?? "2026-06-21T00:00:00Z";
  const fileStamp = sentAt.replace(/[-:]/g, "");
  const file = path.join(inbox, `${input.sender}-${fileStamp}-${input.msgId}.md`);
  writeFileSync(
    file,
    [
      "---",
      `from: ${input.sender}`,
      `to: ${input.frontmatterRecipient ?? input.recipient}`,
      `sent_at: ${sentAt}`,
      `msg_id: ${input.msgId}`,
      "status: unread",
      `in_reply_to: ${input.inReplyTo ?? ""}`,
      `subject: ${input.subject}`,
      "priority: P2",
      "human_authorized_by: ",
      "---",
      `# ${input.subject}`,
      "",
      input.body,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function writeDeliveryEvent(input: {
  personasRoot: string;
  sender: string;
  recipient: string;
  msgId: string;
  sentAt?: string;
  subject: string;
  messagePath: string;
}): void {
  const eventDir = path.join(
    input.personasRoot,
    "_shared",
    "memory",
    "mailbox",
    "_events",
    input.recipient,
  );
  mkdirRecursive(eventDir);
  mkdirRecursive(path.join(eventDir, "archive"));
  const sentAt = input.sentAt ?? "2026-06-21T00:00:00Z";
  const eventStamp = sentAt.replace(/[-:]/g, "");
  writeFileSync(
    path.join(eventDir, `${eventStamp}-${input.msgId}.json`),
    JSON.stringify(
      {
        event_id: `mailbox:${input.msgId}`,
        type: "persona_mail.created",
        from: input.sender,
        to: input.recipient,
        sent_at: sentAt,
        msg_id: input.msgId,
        subject: input.subject,
        message_path: input.messagePath,
        created_at: "2026-06-21T00:00:00Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function mkdirRecursive(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
