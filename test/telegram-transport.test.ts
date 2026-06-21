import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendCrossPersonaMessage } from "../src/telegram-transport.js";

describe("Telegram cross-persona transport", () => {
  let tempDir: string;
  let personasStatePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-telegram-transport-"));
    personasStatePath = path.join(tempDir, "personas.json");
    writeFileSync(
      personasStatePath,
      JSON.stringify({
        "12345": "theo",
        "67890": "albert",
      }),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a persona chat id and sends task-prefixed text through the injected sender", async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 42 });

    const result = await sendCrossPersonaMessage(
      {
        personaName: "Albert",
        text: "请看一下 THEO direct transport。",
        taskId: "ALB-750",
      },
      {
        botToken: "123:telegram-token",
        personasStatePath,
        blockedPersonaPrefixes: ["dadamia_"],
      },
      sender,
    );

    expect(sender).toHaveBeenCalledWith({
      botToken: "123:telegram-token",
      chatId: "67890",
      text: "[TASK ALB-750] 请看一下 THEO direct transport。",
    });
    expect(result).toEqual({
      ok: true,
      persona: "Albert",
      chat_id: "67890",
      task_id: "ALB-750",
      message_id: 42,
    });
  });

  it("splits long cross-persona text before calling Telegram sendMessage", async () => {
    const sender = vi.fn().mockImplementation(async () => ({ messageId: sender.mock.calls.length }));
    const longText = "a".repeat(8_100);

    const result = await sendCrossPersonaMessage(
      {
        personaName: "albert",
        text: longText,
      },
      {
        botToken: "123:telegram-token",
        personasStatePath,
        blockedPersonaPrefixes: ["dadamia_"],
      },
      sender,
    );

    expect(sender).toHaveBeenCalledTimes(3);
    for (const call of sender.mock.calls) {
      expect(call[0]).toMatchObject({
        botToken: "123:telegram-token",
        chatId: "67890",
      });
      expect(call[0].text.length).toBeLessThanOrEqual(4000);
    }
    expect(result).toMatchObject({
      ok: true,
      persona: "albert",
      chat_id: "67890",
      message_id: 3,
    });
  });

  it("blocks B2B persona prefixes before any Telegram send", async () => {
    const sender = vi.fn();

    const result = await sendCrossPersonaMessage(
      {
        personaName: "dadamia_ceo",
        text: "should not send",
      },
      {
        botToken: "123:telegram-token",
        personasStatePath,
        blockedPersonaPrefixes: ["dadamia_"],
      },
      sender,
    );

    expect(sender).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      boundary: "b2b_disabled",
      remediation: "paperclip_decommissioned",
    });
  });

  it("returns a recoverable error when the target persona is not mapped", async () => {
    const sender = vi.fn();

    const result = await sendCrossPersonaMessage(
      {
        personaName: "zoe",
        text: "hello",
      },
      {
        botToken: "123:telegram-token",
        personasStatePath,
        blockedPersonaPrefixes: ["dadamia_"],
      },
      sender,
    );

    expect(sender).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cannot find chat_id for persona 'zoe'"),
    });
  });
});
