import { readFile } from "node:fs/promises";

const TELEGRAM_MESSAGE_LIMIT = 4000;

export interface SendCrossPersonaMessageInput {
  personaName: string;
  text: string;
  taskId?: string;
}

export interface TelegramTransportSettings {
  botToken: string;
  personasStatePath: string;
  blockedPersonaPrefixes: string[];
}

export interface TelegramSendTextInput {
  botToken: string;
  chatId: string;
  text: string;
}

export interface TelegramSendTextResult {
  messageId?: number;
}

export type TelegramSendText = (input: TelegramSendTextInput) => Promise<TelegramSendTextResult>;

export type SendCrossPersonaMessageResult =
  | {
      ok: true;
      persona: string;
      chat_id: string;
      task_id: string | null;
      message_id?: number;
    }
  | {
      ok: false;
      error: string;
      remediation?: string;
      boundary?: string;
    };

export async function sendCrossPersonaMessage(
  input: SendCrossPersonaMessageInput,
  settings: TelegramTransportSettings,
  sendText: TelegramSendText = sendTelegramText,
): Promise<SendCrossPersonaMessageResult> {
  const personaName = input.personaName.trim();
  const text = input.text.trim();
  const taskId = input.taskId?.trim() || null;

  if (!personaName) {
    return { ok: false, error: "persona_name is required" };
  }
  if (!text) {
    return { ok: false, error: "text is required" };
  }

  if (isBlockedPersona(personaName, settings.blockedPersonaPrefixes)) {
    return {
      ok: false,
      error: (
        `persona '${personaName}' is a B2B exec. Paperclip is decommissioned and this family ` +
        "Telegram transport no longer routes B2B work. Ask Albert before creating any new exec-side workflow."
      ),
      remediation: "paperclip_decommissioned",
      boundary: "b2b_disabled",
    };
  }

  const chatId = await resolvePersonaChatId(personaName, settings.personasStatePath);
  if (!chatId) {
    return {
      ok: false,
      error: (
        `Cannot find chat_id for persona '${personaName}'. They may not have messaged the bot yet. ` +
        "Create a shared truth task under the shared task area and it will be surfaced when they next interact."
      ),
    };
  }

  const messageText = taskId ? `[TASK ${taskId}] ${text}` : text;
  try {
    let sent: TelegramSendTextResult | undefined;
    for (const chunk of splitTelegramText(messageText)) {
      sent = await sendText({
        botToken: settings.botToken,
        chatId,
        text: chunk,
      });
    }
    return {
      ok: true,
      persona: personaName,
      chat_id: chatId,
      task_id: taskId,
      message_id: sent?.messageId,
    };
  } catch (error) {
    return {
      ok: false,
      error: safeTelegramErrorMessage(error, settings.botToken),
    };
  }
}

export async function resolvePersonaChatId(
  personaName: string,
  personasStatePath: string,
): Promise<string | null> {
  const target = personaName.trim().toLowerCase();
  if (!target) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(personasStatePath, "utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  for (const [chatId, persona] of Object.entries(parsed)) {
    if (typeof persona === "string" && persona.trim().toLowerCase() === target) {
      return chatId;
    }
  }

  return null;
}

export async function sendTelegramText(input: TelegramSendTextInput): Promise<TelegramSendTextResult> {
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
    }),
  });

  const rawText = await response.text();
  let payload: unknown;
  try {
    payload = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok || !isTelegramOkPayload(payload)) {
    throw new Error(`Telegram sendMessage failed: ${rawText || response.statusText}`);
  }

  return { messageId: payload.result.message_id };
}

export function loadTelegramTransportSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramTransportSettings {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const personasStatePath = env.TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH?.trim();
  if (!personasStatePath) {
    throw new Error("TELEGRAM_TRANSPORT_PERSONAS_STATE_PATH is required");
  }

  return {
    botToken,
    personasStatePath,
    blockedPersonaPrefixes: parseBlockedPrefixes(env.TELEGRAM_TRANSPORT_BLOCKED_PERSONA_PREFIXES),
  };
}

function isBlockedPersona(personaName: string, blockedPrefixes: string[]): boolean {
  const normalized = personaName.trim().toLowerCase();
  return blockedPrefixes.some((prefix) => normalized.startsWith(prefix.trim().toLowerCase()));
}

function parseBlockedPrefixes(raw: string | undefined): string[] {
  const values = raw
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values && values.length > 0 ? values : ["dadamia_"];
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function isTelegramOkPayload(payload: unknown): payload is { ok: true; result: { message_id?: number } } {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.ok !== true || !record.result || typeof record.result !== "object") {
    return false;
  }
  return true;
}

function safeTelegramErrorMessage(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return botToken ? message.replaceAll(botToken, "<redacted>") : message;
}
