import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodexConfig } from "../src/config.js";
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

  it("does not start mailbox fatal recovery when timeout seen-state persistence fails", async () => {
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

    const receipt = JSON.parse(
      readFileSync(
        path.join(
          personasRoot,
          "_shared",
          "memory",
          "mailbox",
          "_receipts",
          "albert-v3",
          "seen-fails-before-fatal.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.status).toBe("failed_prompt_timeout");
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

  it("keeps the inbox message recoverable if receipt persistence fails after archive copy", async () => {
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

    await expect(
      runMailboxDeliveryOnce(createConfig({ personasRoot, workspace }), createRegistry(session) as never),
    ).rejects.toThrow();

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
    expect(existsSync(path.join(workspace, ".telecodex", "mailbox_seen_albert-v3.json"))).toBe(false);
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
      promptTimeoutMs: undefined,
    },
  };
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
