import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
import { HANDOFF_MARKER } from "../src/handoff-buffer.js";
import { runMailboxDeliveryOnce, startMailboxBridge } from "../src/mailbox.js";

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
    expect(promptText).toContain("[DEVELOPER DISCIPLINE]");
    expect(promptText).toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(promptText).toContain("fix at the earliest reliable boundary");
    expect(promptText).toContain("[CURRENT CONTEXT]");
    expect(promptText).toContain("Current model: gpt-5.5");
    expect(promptText).toContain("Current launch behavior: read-only / never");
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

  it("opens mailbox Codex sessions with the configured mailbox launch profile", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-readonly-profile",
      subject: "Use readonly profile",
      body: "Please confirm the mailbox bridge uses the safe launch profile.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("NO_REPLY");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.launchProfileId = "readonly";

    await runMailboxDeliveryOnce(config, registry as never);

    expect(registry.getOrCreate).toHaveBeenCalledWith("mailbox:albert-v3", {
      launchProfileId: "readonly",
    });
  });

  it("honors the explicit unsafe mailbox launch profile override at delivery time", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-unsafe-profile",
      subject: "Use developer profile",
      body: "Please confirm the mailbox bridge can use the explicitly approved developer profile.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("developer profile mailbox reply");
      callbacks.onAgentEnd();
    });
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      launchProfileId: "developer",
      launchProfileLabel: "Developer",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.launchProfileId = "developer";
    config.mailboxBridge.allowUnsafeLaunchProfile = true;

    const result = await runMailboxDeliveryOnce(config, registry as never);

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 0 });
    expect(registry.getOrCreate).toHaveBeenCalledWith("mailbox:albert-v3", {
      launchProfileId: "developer",
    });
  });

  it("rejects unsafe mailbox sessions that would require runtime approvals", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "msg-unsafe-on-request",
      subject: "Reject review profile",
      body: "This mailbox turn must not use an approval-gated profile.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("NO_REPLY");
      callbacks.onAgentEnd();
    });
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      launchProfileId: "review",
      launchProfileLabel: "Review",
      launchProfileBehavior: "workspace-write / on-request",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      unsafeLaunch: false,
    });
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.launchProfileId = "review";
    config.mailboxBridge.allowUnsafeLaunchProfile = true;

    await expect(runMailboxDeliveryOnce(config, createRegistry(session) as never)).rejects.toThrow(
      "MAILBOX_ALLOW_UNSAFE_LAUNCH_PROFILE requires a never approval Codex session",
    );
  });

  it("strips echoed dispatcher discipline before writing mailbox replies", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "echo-guard-reply",
      subject: "Guard echo",
      body: "Please reply without leaking dispatcher guard text.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.(
        [
          "[DEVELOPER DISCIPLINE]",
          "discipline_version=ALB-714-hard-discipline-v1",
          "Fix root cause: explain why a bug happened before fixing it, then fix at the earliest reliable boundary.",
          "",
          "clean mailbox reply",
        ].join("\n"),
      );
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 0 });
    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"));
    expect(replies).toHaveLength(1);
    const replyText = readFileSync(
      path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox", replies[0]!),
      "utf8",
    );
    expect(replyText).toContain("clean mailbox reply");
    expect(replyText).not.toContain("[DEVELOPER DISCIPLINE]");
    expect(replyText).not.toContain("discipline_version=ALB-714-hard-discipline-v1");
    expect(replyText).not.toContain("Fix root cause");
  });

  it("treats guard-echoed NO_REPLY as no mailbox reply", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "echo-guard-no-reply",
      subject: "Guard echo no reply",
      body: "This does not need a mailbox reply.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.(
        [
          "[CURRENT CONTEXT]",
          "You are Albert Codex Dispatcher backend for Telegram.",
          "Current model: gpt-5.5",
          "",
          "NO_REPLY",
        ].join("\n"),
      );
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 0, skipped: 0 });
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
  });

  it("ignores unsafe frontmatter path segments before processing", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "safe-file-sender",
      frontmatterSender: "../outside",
      recipient: "albert-v3",
      msgId: "safe-file-id",
      frontmatterMsgId: "../escape",
      subject: "Unsafe path fields",
      body: "This should not reach Codex or create files outside the mailbox.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("should not run");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 0 });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(existsSync(inboundPath)).toBe(true);
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "outside"))).toBe(false);
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "_receipts", "escape.json"))).toBe(false);
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

  it("quarantines a non-timeout Codex failure once so a bad message cannot starve the next one", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    for (const [msgId, sentAt] of [
      ["fatal-first", "2026-06-21T00:00:00Z"],
      ["second-ok-after-fatal", "2026-06-21T00:00:01Z"],
    ] as const) {
      writeMailboxMessage({
        personasRoot,
        sender: "cody",
        recipient: "albert-v3",
        msgId,
        sentAt,
        subject: msgId,
        body: msgId,
      });
      writeDeliveryEvent({
        personasRoot,
        sender: "cody",
        recipient: "albert-v3",
        msgId,
        sentAt,
        subject: msgId,
        messagePath: "unused",
      });
    }

    const session = createSession(async (input, callbacks) => {
      if (String(input).includes("msg_id: fatal-first")) {
        throw new Error("codex turn.failed");
      }
      callbacks.onAgentMessage?.("later message processed");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });

    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 0,
      replied: 0,
      skipped: 1,
    });
    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 1,
      replied: 1,
      skipped: 0,
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    const seen = JSON.parse(
      readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["fatal-first"].status).toBe("failed_unexpected");
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "fatal-first.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("failed_unexpected");
  });

  it("persists the unexpected failure reason in the quarantine receipt", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "auditable-failure",
      subject: "Audit failure",
      body: "Preserve the failure reason.",
    });

    const session = createSession(async () => {
      throw new Error("codex turn.failed: provider unavailable");
    });

    await runMailboxDeliveryOnce(
      createConfig({ personasRoot, workspace }),
      createRegistry(session) as never,
    );

    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "auditable-failure.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.failure_reason).toBe("codex turn.failed: provider unavailable");
  });

  it("finalizes a stale processing claim as interrupted without rerunning the Codex turn", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const messagePath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stale-processing",
      subject: "Stale processing",
      body: "Do not rerun after a process crash.",
    });
    const stateDir = path.join(workspace, ".telecodex");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "mailbox_seen_albert-v3.json"),
      JSON.stringify({
        messages: {
          "stale-processing": {
            processedAt: "2026-06-21T00:00:00.000Z",
            from: "cody",
            path: messagePath,
            status: "processing",
          },
        },
      }),
      "utf8",
    );
    const session = createSession(async () => {
      throw new Error("stale claim must not rerun");
    });

    expect(
      await runMailboxDeliveryOnce(
        createConfig({ personasRoot, workspace }),
        createRegistry(session) as never,
      ),
    ).toEqual({ processed: 0, replied: 0, skipped: 1 });

    expect(session.prompt).not.toHaveBeenCalled();
    const seen = JSON.parse(
      readFileSync(path.join(stateDir, "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["stale-processing"]).toMatchObject({
      status: "failed_unexpected",
      failureReason: "interrupted_before_terminal_state",
    });
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "stale-processing.json",
        ),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      status: "failed_unexpected",
      failure_reason: "interrupted_before_terminal_state",
    });
  });


  it.each([
    ["processed", undefined],
    ["failed_unexpected", "codex turn.failed: original provider error"],
  ])("recovers stale seen state from an existing %s receipt without overwriting terminal evidence", async (status, failureReason) => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const msgId = "stale-with-" + status;
    const messagePath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId,
      subject: "Recover terminal receipt",
      body: "Do not overwrite the terminal receipt after restart.",
    });
    const stateDir = path.join(workspace, ".telecodex");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "mailbox_seen_albert-v3.json"),
      JSON.stringify({
        messages: {
          [msgId]: {
            processedAt: "2026-06-21T00:00:00.000Z",
            from: "cody",
            path: messagePath,
            status: "processing",
          },
        },
      }),
      "utf8",
    );
    const receiptDir = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
    );
    mkdirRecursive(receiptDir);
    const receiptPath = path.join(receiptDir, msgId + ".json");
    const terminalReceipt = {
      msg_id: msgId,
      from: "cody",
      to: "albert-v3",
      subject: "Recover terminal receipt",
      sent_at: "2026-06-21T00:00:00Z",
      status,
      delivered_by: "telecodex-mailbox-bridge",
      recorded_at: "2026-06-21T00:00:01.000Z",
      message_path: messagePath,
      failure_reason: failureReason,
    };
    writeFileSync(receiptPath, JSON.stringify(terminalReceipt), "utf8");

    const session = createSession(async () => {
      throw new Error("terminal receipt must prevent rerun");
    });
    expect(
      await runMailboxDeliveryOnce(
        createConfig({ personasRoot, workspace }),
        createRegistry(session) as never,
      ),
    ).toEqual({ processed: 0, replied: 0, skipped: 1 });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(terminalReceipt);
    const seen = JSON.parse(
      readFileSync(path.join(stateDir, "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages[msgId]).toMatchObject({
      status,
      ...(failureReason ? { failureReason } : {}),
    });
    if (!failureReason) {
      expect(seen.messages[msgId]).not.toHaveProperty("failureReason");
    }
  });

  it("rejects a forged terminal receipt instead of trusting it as a completed delivery", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const msgId = "stale-with-forged-receipt";
    const messagePath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId,
      subject: "Reject forged receipt",
      body: "A malformed receipt must not become terminal truth.",
    });
    const stateDir = path.join(workspace, ".telecodex");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "mailbox_seen_albert-v3.json"),
      JSON.stringify({
        messages: {
          [msgId]: {
            processedAt: "2026-06-21T00:00:00.000Z",
            from: "cody",
            path: messagePath,
            status: "processing",
          },
        },
      }),
      "utf8",
    );
    const receiptDir = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
    );
    mkdirRecursive(receiptDir);
    const receiptPath = path.join(receiptDir, msgId + ".json");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        msg_id: msgId,
        from: "mallory",
        to: "albert-v3",
        status: "garbage",
        delivered_by: "unknown-bridge",
        recorded_at: "2026-06-21T00:00:01.000Z",
        message_path: path.join(tempDir, "outside-mailbox.md"),
      }),
      "utf8",
    );

    const session = createSession(async () => {
      throw new Error("forged receipt must not rerun the claimed turn");
    });
    expect(
      await runMailboxDeliveryOnce(
        createConfig({ personasRoot, workspace }),
        createRegistry(session) as never,
      ),
    ).toEqual({ processed: 0, replied: 0, skipped: 1 });

    expect(session.prompt).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      msg_id: msgId,
      from: "cody",
      to: "albert-v3",
      status: "failed_unexpected",
      delivered_by: "telecodex-mailbox-bridge",
      message_path: messagePath,
      failure_reason: "interrupted_before_terminal_state",
    });
  });

  it("continues to a later message when stale-claim receipt persistence fails", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const stalePath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stale-receipt-fails",
      subject: "Broken stale receipt",
      body: "This stale claim must not block the next message.",
      sentAt: "2026-06-21T00:00:00Z",
    });
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "later-after-stale",
      subject: "Later message",
      body: "Process this after isolating the stale claim.",
      sentAt: "2026-06-21T00:00:01Z",
    });
    const stateDir = path.join(workspace, ".telecodex");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "mailbox_seen_albert-v3.json"),
      JSON.stringify({
        messages: {
          "stale-receipt-fails": {
            processedAt: "2026-06-21T00:00:00.000Z",
            from: "cody",
            path: stalePath,
            status: "processing",
          },
        },
      }),
      "utf8",
    );
    const brokenReceiptPath = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
      "stale-receipt-fails.json",
    );
    mkdirRecursive(brokenReceiptPath);

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("later message processed");
      callbacks.onAgentEnd();
    });
    const result = await runMailboxDeliveryOnce(
      createConfig({ personasRoot, workspace, maxMessagesPerTick: 2 }),
      createRegistry(session) as never,
    );

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 1 });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    const seen = JSON.parse(
      readFileSync(path.join(stateDir, "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["stale-receipt-fails"]).toMatchObject({
      status: "failed_unexpected",
      failureReason: "interrupted_before_terminal_state",
    });
    expect(seen.messages["later-after-stale"].status).toBe("processed");
  });

  it("claims a message before reply side effects so finalization failure cannot rerun the Codex turn", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "claimed-before-reply",
      subject: "Claim before reply",
      body: "Reply exactly once even if receipt persistence fails.",
    });
    const brokenReceiptDir = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
    );
    mkdirRecursive(path.dirname(brokenReceiptDir));
    writeFileSync(brokenReceiptDir, "not a directory", "utf8");

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("one reply only");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });

    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 0,
      replied: 1,
      skipped: 1,
    });

    rmSync(brokenReceiptDir, { force: true });
    mkdirRecursive(brokenReceiptDir);
    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 0,
      replied: 0,
      skipped: 0,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const replies = await readdir(
      path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"),
    );
    expect(replies).toHaveLength(1);
    const seen = JSON.parse(
      readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["claimed-before-reply"].status).toBe("failed_unexpected");
  });

  it("quarantines a newThread failure before moving on to a later message", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    for (const [msgId, sentAt] of [
      ["new-thread-fails", "2026-06-21T00:00:00Z"],
      ["new-thread-recovers", "2026-06-21T00:00:01Z"],
    ] as const) {
      writeMailboxMessage({
        personasRoot,
        sender: "cody",
        recipient: "albert-v3",
        msgId,
        sentAt,
        subject: msgId,
        body: msgId,
      });
    }

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("thread recovered");
      callbacks.onAgentEnd();
    });
    session.hasActiveThread.mockReturnValue(false);
    session.newThread.mockRejectedValueOnce(new Error("session.newThread failed")).mockResolvedValue(undefined);
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });

    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 0,
      replied: 0,
      skipped: 1,
    });
    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({
      processed: 1,
      replied: 1,
      skipped: 0,
    });
    expect(session.newThread).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("quarantines a stuck mailbox Codex turn without archiving or marking the message read", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-msg",
      subject: "Stuck mailbox turn",
      body: "This prompt never returns.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-msg",
      subject: "Stuck mailbox turn",
      messagePath: inboundPath,
    });

    const session = createSession(async () => {
      await new Promise(() => undefined);
    });
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.promptTimeoutMs = 5;

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(existsSync(inboundPath)).toBe(true);
    expect(readFileSync(inboundPath, "utf8")).toContain("status: unread");
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "stuck-msg.json",
        ),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      msg_id: "stuck-msg",
      status: "failed_prompt_timeout",
      message_path: inboundPath,
    });
    const seen = JSON.parse(readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"));
    expect(seen.messages["stuck-msg"]).toMatchObject({
      from: "cody",
      path: inboundPath,
      status: "failed_prompt_timeout",
    });
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
          "20260621T000000Z-stuck-msg.json",
        ),
      ),
    ).toBe(true);
  });

  it("quarantines a mailbox turn that settles only after the prompt timeout fires", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "late-after-timeout",
      subject: "Late after timeout",
      body: "This prompt returns after timeout but before abort grace expires.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "late-after-timeout",
      subject: "Late after timeout",
      messagePath: inboundPath,
    });

    const abortCalled = deferred<void>();
    let processing = false;
    const session = createSession(async (_input, callbacks) => {
      processing = true;
      await abortCalled.promise;
      await delay(10);
      callbacks.onAgentMessage?.("late reply should not be mailed");
      callbacks.onAgentEnd();
      processing = false;
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockImplementation(async () => {
      abortCalled.resolve();
    });
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 50;
    config.mailboxBridge.promptTimeoutMs = 5;

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never);

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(existsSync(inboundPath)).toBe(true);
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "late-after-timeout.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("failed_prompt_timeout");
    await delay(20);
    expect(existsSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"))).toBe(false);
  });

  it("reports fatal recovery when a timed-out mailbox Codex turn remains active after abort grace", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-after-abort",
      subject: "Stuck after abort",
      body: "This prompt ignores abort and never releases the session.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-after-abort",
      subject: "Stuck after abort",
      messagePath: inboundPath,
    });

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 5;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never, { onFatalRecovery });

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(existsSync(inboundPath)).toBe(true);
    expect(readFileSync(inboundPath, "utf8")).toContain("status: unread");
    await vi.waitFor(() => expect(onFatalRecovery).toHaveBeenCalledTimes(1));
    expect(String(onFatalRecovery.mock.calls[0]?.[0]?.message)).toContain(
      "Mailbox Codex turn remained active after timeout abort grace",
    );
  });

  it("persists the timeout quarantine before starting mailbox fatal recovery", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "quarantine-before-fatal",
      subject: "Quarantine before fatal",
      body: "This prompt should leave evidence before fatal recovery is allowed.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "quarantine-before-fatal",
      subject: "Quarantine before fatal",
      messagePath: inboundPath,
    });

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 1;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never, { onFatalRecovery });

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(onFatalRecovery).not.toHaveBeenCalled();
    expect(readFileSync(inboundPath, "utf8")).toContain("status: unread");
    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "quarantine-before-fatal.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("failed_prompt_timeout");
    const seen = JSON.parse(readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"));
    expect(seen.messages["quarantine-before-fatal"]).toMatchObject({
      path: inboundPath,
      status: "failed_prompt_timeout",
    });
    await vi.waitFor(() => expect(onFatalRecovery).toHaveBeenCalledTimes(1));
  });

  it("does not start mailbox fatal recovery when timeout quarantine persistence fails", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "quarantine-fails-before-fatal",
      subject: "Quarantine fails before fatal",
      body: "This prompt should not fatal before timeout evidence is persisted.",
    });
    const brokenReceiptDir = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
    );
    mkdirRecursive(path.dirname(brokenReceiptDir));
    writeFileSync(brokenReceiptDir, "not a directory", "utf8");

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 1;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    await expect(
      runMailboxDeliveryOnce(config, createRegistry(session) as never, { onFatalRecovery }),
    ).rejects.toThrow();
    await delay(10);

    expect(onFatalRecovery).not.toHaveBeenCalled();
  });

  it("does not start a mailbox turn when durable claim persistence fails", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "seen-fails-before-fatal",
      subject: "Seen fails before fatal",
      body: "This prompt should not fatal before seen-state timeout evidence is persisted.",
    });
    mkdirRecursive(workspace);
    writeFileSync(path.join(workspace, ".telecodex"), "not a directory", "utf8");

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 1;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    await expect(
      runMailboxDeliveryOnce(config, createRegistry(session) as never, { onFatalRecovery }),
    ).rejects.toThrow();
    await delay(10);

    expect(session.prompt).not.toHaveBeenCalled();
    expect(onFatalRecovery).not.toHaveBeenCalled();
  });

  it("uses the mailbox prompt timeout as default abort grace when no global grace is configured", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "default-mailbox-abort-grace",
      subject: "Default mailbox abort grace",
      body: "This prompt ignores abort and should recover even without CODEX_TURN_ABORT_GRACE_MS.",
    });

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = undefined;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    const result = await runMailboxDeliveryOnce(config, createRegistry(session) as never, { onFatalRecovery });

    expect(result).toEqual({ processed: 0, replied: 0, skipped: 1 });
    await vi.waitFor(() => expect(onFatalRecovery).toHaveBeenCalledTimes(1));
    expect(String(onFatalRecovery.mock.calls[0]?.[0]?.message)).toContain(
      "Mailbox Codex turn remained active after timeout abort grace (5ms timeout, 5ms grace)",
    );
  });

  it("escalates mailbox stuck-after-abort errors to fatal recovery", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "bridge-stuck-after-abort",
      subject: "Bridge stuck after abort",
      body: "This prompt ignores abort and should force launchd recovery.",
    });

    let processing = false;
    const session = createSession(async () => {
      processing = true;
      await new Promise(() => undefined);
    });
    session.isProcessing.mockImplementation(() => processing);
    session.abort.mockResolvedValue(undefined);
    const config = createConfig({ personasRoot, workspace });
    config.codexTurnAbortGraceMs = 5;
    config.mailboxBridge.promptTimeoutMs = 5;
    const onFatalRecovery = vi.fn();

    const stop = startMailboxBridge(config, createRegistry(session) as never, { onFatalRecovery });
    try {
      await vi.waitFor(() => expect(onFatalRecovery).toHaveBeenCalledTimes(1), { timeout: 200 });
    } finally {
      stop?.();
    }

    expect(String(onFatalRecovery.mock.calls[0]?.[0]?.message)).toContain(
      "Mailbox Codex turn remained active after timeout abort grace",
    );
  });

  it("does not let a quarantined timed-out mailbox message starve later messages", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-first",
      sentAt: "2026-06-21T00:00:00Z",
      subject: "Stuck first",
      body: "This prompt never returns.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "stuck-first",
      sentAt: "2026-06-21T00:00:00Z",
      subject: "Stuck first",
      messagePath: "unused",
    });
    writeMailboxMessage({
      personasRoot,
      sender: "mira",
      recipient: "albert-v3",
      msgId: "second-ok",
      sentAt: "2026-06-21T00:00:01Z",
      subject: "Second ok",
      body: "This should run after the stuck message is quarantined.",
    });
    writeDeliveryEvent({
      personasRoot,
      sender: "mira",
      recipient: "albert-v3",
      msgId: "second-ok",
      sentAt: "2026-06-21T00:00:01Z",
      subject: "Second ok",
      messagePath: "unused",
    });

    const session = createSession(async (input, callbacks) => {
      if (String(input).includes("msg_id: stuck-first")) {
        await new Promise(() => undefined);
        return;
      }
      callbacks.onAgentMessage?.("later message processed");
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const config = createConfig({ personasRoot, workspace });
    config.mailboxBridge.promptTimeoutMs = 5;

    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({ processed: 0, replied: 0, skipped: 1 });
    expect(await runMailboxDeliveryOnce(config, registry as never)).toEqual({ processed: 1, replied: 1, skipped: 0 });

    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "mira", "inbox"));
    expect(replies).toHaveLength(1);
    expect(readFileSync(path.join(personasRoot, "_shared", "memory", "mailbox", "mira", "inbox", replies[0]!), "utf8")).toContain(
      "later message processed",
    );
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

  it("uses current time for auto-replies instead of the incoming sent_at", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "reply-time",
      sentAt: "2026-06-21T00:00:00Z",
      subject: "Reply time",
      body: "Reply timestamp should be generated at send time.",
    });

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("fresh reply time");
      callbacks.onAgentEnd();
    });

    const result = await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never);

    expect(result).toEqual({ processed: 1, replied: 1, skipped: 0 });
    const replies = await readdir(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox"));
    const replyText = readFileSync(path.join(personasRoot, "_shared", "memory", "mailbox", "cody", "inbox", replies[0]!), "utf8");
    expect(replyText).not.toContain("sent_at: 2026-06-21T00:00:00Z");
  });

  it("keeps the inbox message for audit and marks it failed if receipt persistence breaks after archive copy", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const inboundPath = writeMailboxMessage({
      personasRoot,
      sender: "cody",
      recipient: "albert-v3",
      msgId: "receipt-fails",
      subject: "Receipt fails",
      body: "Inbox should remain if downstream persistence fails.",
    });
    const brokenReceiptDir = path.join(
      personasRoot,
      "_shared",
      "memory",
      "mailbox",
      "_receipts",
      "albert-v3",
    );
    mkdirRecursive(path.dirname(brokenReceiptDir));
    writeFileSync(brokenReceiptDir, "not a directory", "utf8");

    const session = createSession(async (_input, callbacks) => {
      callbacks.onAgentMessage?.("NO_REPLY");
      callbacks.onAgentEnd();
    });

    expect(
      await runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never),
    ).toEqual({ processed: 0, replied: 0, skipped: 1 });

    expect(existsSync(inboundPath)).toBe(true);
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
    const seen = JSON.parse(
      readFileSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"), "utf8"),
    );
    expect(seen.messages["receipt-fails"].status).toBe("failed_unexpected");
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

  it("rotates the mailbox thread when a turn goes heavy and snapshots the still-queued messages (ALB-1205)", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    for (const [msgId, subject] of [
      ["mbx-a", "重活A"],
      ["mbx-b", "接着B"],
      ["mbx-c", "排队C"],
    ] as const) {
      writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId, subject, body: subject });
    }

    let turn = 0;
    const session = createSession(async (_input, callbacks) => {
      turn += 1;
      callbacks.onAgentMessage?.(`ok-${turn}`);
      // Turn 1 crosses the rotate threshold (130000/258400 ≈ 0.50 ≥ 0.45).
      callbacks.onTurnComplete?.({ inputTokens: turn === 1 ? 130000 : 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runMailboxDeliveryOnce(
      createConfig({
        personasRoot,
        workspace,
        maxMessagesPerTick: 3,
        autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 } as never,
      }),
      registry as never,
    );

    expect(result.processed).toBe(3);
    // Only message B rotates (turn 1 has no pending rotation yet).
    expect(session.newThread).toHaveBeenCalledTimes(1);
    const rotatedInput = JSON.stringify(session.prompt.mock.calls[1]![0]);
    expect(rotatedInput).toContain(HANDOFF_MARKER);
    expect(rotatedInput).toContain("未答消息");
    // Message C is still queued behind B at the instant B rotates.
    expect(rotatedInput).toContain("排队C");
    // ALB-1205 A7: the mailbox rotation must be OBSERVABLE. The Telegram path logs
    // "Auto-rotated ..." but the mailbox path (where worker bots spend most turns)
    // rotated silently — leaving prod monitoring and A7-style verification blind to
    // the main rotation path. A successful mailbox rotation must emit a greppable line.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Auto-rotated"))).toBe(true);
  });

  it("carries a bounded single-line body excerpt in mailbox rotation descriptors (ALB-1205 §A.4)", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    // Bodies deliberately differ from subjects: subject-only descriptors would
    // still pass the older rotation tests (where subject === body) while losing
    // "那封信要干嘛" across the rotation — the exact §A.4 fidelity gap.
    const longTail = "x".repeat(1300);
    writeMailboxMessage({
      personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-fid-a",
      subject: "重活A", body: "重活A的正文：请先核对部署脚本超时兜底",
    });
    writeMailboxMessage({
      personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-fid-b",
      subject: "接着B", body: "接着B的正文",
    });
    writeMailboxMessage({
      personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-fid-c",
      subject: "排队C", body: `排队C正文第一行\n排队C正文第二行 ${longTail}`,
    });

    let turn = 0;
    const session = createSession(async (_input, callbacks) => {
      turn += 1;
      callbacks.onAgentMessage?.(`ok-${turn}`);
      // Turn 1 crosses the rotate threshold (130000/258400 ≈ 0.50 ≥ 0.45).
      callbacks.onTurnComplete?.({ inputTokens: turn === 1 ? 130000 : 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runMailboxDeliveryOnce(
      createConfig({
        personasRoot,
        workspace,
        maxMessagesPerTick: 3,
        autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 } as never,
      }),
      registry as never,
    );

    const rotatedInput = JSON.stringify(session.prompt.mock.calls[1]![0]);
    expect(rotatedInput).toContain(HANDOFF_MARKER);
    // recordTurn path: message A's descriptor in the recent-conversation section
    // carries the body excerpt, not just the subject line.
    expect(rotatedInput).toContain("[内部信] cody → 重活A | 正文摘录: 重活A的正文：请先核对部署脚本超时兜底");
    // unanswered-snapshot path: still-queued message C carries its body excerpt too.
    expect(rotatedInput).toContain("[内部信] cody → 排队C | 正文摘录: 排队C正文第一行 排队C正文第二行");
    // The mailbox writer duplicates the subject as a leading `# <subject>` body
    // heading (real inbox files do this); the excerpt must not waste its budget
    // repeating the subject the descriptor already carries.
    expect(rotatedInput).not.toContain("正文摘录: # 排队C");
    // A multi-line body is collapsed to a single line so it cannot break the
    // HANDOFF's line-oriented sections ("\\n" here is the JSON-escaped newline).
    expect(rotatedInput).not.toContain("排队C正文第一行\\n");
    // The excerpt is bounded by the shared per-entry cap (1200, §A.4/ALB-1220): the 1300-char tail is cut.
    expect(rotatedInput).not.toContain(longTail);
    expect(rotatedInput).toContain("…");
  });

  it("carries a 最后断点 into the next mailbox rotation when a heavy turn times out (ALB-1205)", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const rotateCfg = {
      personasRoot,
      workspace,
      promptTimeoutMs: 40,
      autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 } as never,
    };

    let turn = 0;
    const session = createSession(async (_input, callbacks) => {
      turn += 1;
      if (turn === 2) {
        // The rotated turn hangs → the mailbox turn timeout aborts it.
        await new Promise(() => {});
        return;
      }
      callbacks.onAgentMessage?.(`ok-${turn}`);
      callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Tick 1: message A completes heavy → last known ratio ≈ 0.50, pending rotation persisted.
    writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-1", subject: "重活一", body: "重活一" });
    await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);

    // Tick 2: message B rotates onto a fresh thread, then times out mid-answer.
    // Body differs from subject so the breakpoint fidelity (§A.4) is observable.
    const interruptedPath = writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-2", subject: "会超时的二", body: "会超时的二的正文：先把 rotation 设计稿补完" });
    await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(session.abort).toHaveBeenCalled();

    expect(existsSync(interruptedPath)).toBe(true);

    // Tick 3: the same unread message B is retried automatically on a fresh thread.
    const recovered = await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(recovered).toEqual({ processed: 1, replied: 1, skipped: 0 });
    expect(existsSync(interruptedPath)).toBe(false);

    const lastPrompt = JSON.stringify(session.prompt.mock.calls.at(-1)![0]);
    expect(lastPrompt).toContain(HANDOFF_MARKER);
    expect(lastPrompt).toContain("最后断点");
    expect(lastPrompt).toContain("会超时的二");
    // §A.4: the interrupted breakpoint keeps the letter's body excerpt — a
    // subject-only breakpoint loses what the interrupted letter was asking for.
    expect(lastPrompt).toContain("正文摘录: 会超时的二的正文：先把 rotation 设计稿补完");
  });

  it("quarantines the same heavy mailbox message after its one automatic resume also times out", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const rotateCfg = {
      personasRoot, workspace, promptTimeoutMs: 20,
      autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 } as never,
    };
    let turn = 0;
    const session = createSession(async (_input, callbacks) => {
      turn += 1;
      if (turn >= 2) { await new Promise(() => {}); return; }
      callbacks.onAgentMessage?.("heavy-ok");
      callbacks.onTurnComplete?.({ inputTokens: 130000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    const registry = createRegistry(session);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "retry-a", subject: "heavy", body: "heavy" });
    await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    const retryPath = writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "retry-b", subject: "retry", body: "retry" });
    await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(existsSync(retryPath)).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(session.abort).toHaveBeenCalledTimes(2);
    const receipt = JSON.parse(readFileSync(path.join(personasRoot, "_shared", "memory", "mailbox", "_receipts", "albert-v3", "retry-b.json"), "utf8"));
    expect(receipt.status).toBe("failed_prompt_timeout");
    const fourth = await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(fourth.processed).toBe(0);
  });

  it("refuses a mandatory (hard-cap) mailbox rotation on the over-cap thread when newThread fails, deferring the message (ALB-1205)", async () => {
    const personasRoot = path.join(tempDir, "personas");
    const workspace = path.join(tempDir, "workspace");
    const rotateCfg = {
      personasRoot,
      workspace,
      autoRotate: { enabled: true, threshold: 0.45, hardCap: 0.6, contextWindow: 258400 } as never,
    };

    let turn = 0;
    const session = createSession(async (_input, callbacks) => {
      turn += 1;
      callbacks.onAgentMessage?.(`ok-${turn}`);
      // Turn 1 crosses the hard cap (200000/258400 ≈ 0.77 ≥ 0.60) → mandatory pending.
      callbacks.onTurnComplete?.({ inputTokens: turn === 1 ? 200000 : 40000, cachedInputTokens: 0, outputTokens: 5 });
      callbacks.onAgentEnd();
    });
    // Tick 2's mandatory rotation retries newThread twice; both fail. Tick 3 recovers.
    session.newThread
      .mockRejectedValueOnce(new Error("mailbox newThread failure #1"))
      .mockRejectedValueOnce(new Error("mailbox newThread failure #2"))
      .mockResolvedValue(session.getInfo());
    const registry = createRegistry(session);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Tick 1: message A completes over the hard cap → mandatory pending persisted.
    writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-hc-1", subject: "顶过硬上限的一", body: "顶过硬上限的一" });
    const tick1 = await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(tick1.processed).toBe(1);
    expect(session.newThread).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);

    // Tick 2: mandatory rotation → newThread tried twice, both fail → the turn must be
    // REFUSED (no prompt on the over-cap thread) and the message left for a later tick.
    writeMailboxMessage({ personasRoot, sender: "cody", recipient: "albert-v3", msgId: "mbx-hc-2", subject: "不该在超顶线程跑的二", body: "不该在超顶线程跑的二" });
    const tick2 = await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(session.newThread).toHaveBeenCalledTimes(2);
    expect(session.prompt).toHaveBeenCalledTimes(1); // B was NOT run on the over-cap thread
    expect(tick2.processed).toBe(0); // B deferred, still unread for the next tick

    // Tick 3: newThread recovers → the preserved mandatory pending finally rotates and B runs.
    const tick3 = await runMailboxDeliveryOnce(createConfig(rotateCfg), registry as never);
    expect(session.newThread).toHaveBeenCalledTimes(3);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(tick3.processed).toBe(1);
    const rotatedInput = JSON.stringify(session.prompt.mock.calls[1]![0]);
    expect(rotatedInput).toContain(HANDOFF_MARKER);
    expect(rotatedInput).toContain("硬上限");
  });
});

function createConfig(overrides: {
  personasRoot: string;
  workspace: string;
  autoRotate?: TeleCodexConfig["autoRotate"];
  maxMessagesPerTick?: number;
  promptTimeoutMs?: number;
}): TeleCodexConfig {
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
    ...(overrides.autoRotate ? { autoRotate: overrides.autoRotate } : {}),
    mailboxBridge: {
      enabled: true,
      persona: "albert-v3",
      personasRoot: overrides.personasRoot,
      contextKey: undefined,
      launchProfileId: undefined,
      pollMs: 500,
      fullScanMs: 10_000,
      autoReply: true,
      maxMessagesPerTick: overrides.maxMessagesPerTick ?? 1,
      minSentAt: undefined,
      promptTimeoutMs: overrides.promptTimeoutMs,
    },
  } as TeleCodexConfig;
}

function createSession(onPrompt: (input: unknown, callbacks: CodexSessionCallbacks) => Promise<void>) {
  return {
    isProcessing: vi.fn(() => false),
    hasActiveThread: vi.fn(() => true),
    newThread: vi.fn(),
    abort: vi.fn(async () => undefined),
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMailboxMessage(input: {
  personasRoot: string;
  sender: string;
  frontmatterSender?: string;
  recipient: string;
  msgId: string;
  frontmatterMsgId?: string;
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
      `from: ${input.frontmatterSender ?? input.sender}`,
      `to: ${input.frontmatterRecipient ?? input.recipient}`,
      `sent_at: ${sentAt}`,
      `msg_id: ${input.frontmatterMsgId ?? input.msgId}`,
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
