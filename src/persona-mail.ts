import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type PersonaMailPriority = "P0" | "P1" | "P2" | "P3";

export interface SendPersonaMailInput {
  to: string;
  subject: string;
  body: string;
  priority?: PersonaMailPriority;
}

export interface PersonaMailSettings {
  personasRoot: string;
  sender: string;
}

export type SendPersonaMailResult =
  | {
      ok: true;
      from: string;
      to: string;
      resolved_alias: string | null;
      subject: string;
      priority: PersonaMailPriority;
      sent_at: string;
      msg_id: string;
      message_path: string;
    }
  | {
      ok: false;
      error: string;
      boundary?: string;
    };

const DEFAULT_ALIASES: Record<string, string> = {
  ada: "albert-codex-e2e",
  alex: "albert-v5",
  cody: "cody",
  iris: "albert-v8",
  nora: "albert",
  otto: "albert-v6",
  testbot: "codex-testbot",
  theo: "albert-v3",
  vera: "albert-v4",
};

export async function sendPersonaMail(
  input: SendPersonaMailInput,
  settings: PersonaMailSettings,
): Promise<SendPersonaMailResult> {
  const sender = settings.sender.trim();
  const rawRecipient = input.to.trim();
  const subject = normalizeSingleLine(input.subject);
  const body = input.body.trim();
  const priority = normalizePriority(input.priority);

  if (!isSafeSegment(sender)) {
    return { ok: false, error: "MAILBOX_PERSONA must be a safe single path segment", boundary: "invalid_sender" };
  }
  if (!rawRecipient) {
    return { ok: false, error: "to is required" };
  }
  if (!subject) {
    return { ok: false, error: "subject is required" };
  }
  if (!body) {
    return { ok: false, error: "body is required" };
  }

  const resolved = await resolveRecipient(rawRecipient, settings.personasRoot);
  if (!resolved) {
    return {
      ok: false,
      error: "Unknown persona recipient: " + rawRecipient + ". Use a real persona slug or configured display-name alias.",
      boundary: "unknown_recipient",
    };
  }

  const sentAt = currentMailboxTimestamp();
  const msgId = randomUUID();
  const inbox = path.join(settings.personasRoot, "_shared", "memory", "mailbox", resolved.slug, "inbox");
  await mkdir(inbox, { recursive: true });
  const messagePath = path.join(inbox, safeFilePart(sender) + "-" + compactTimestamp(sentAt) + "-" + msgId + ".md");
  await writeFile(
    messagePath,
    renderMailboxFile({
      from: sender,
      to: resolved.slug,
      sentAt,
      msgId,
      subject,
      priority,
      body,
    }),
    "utf8",
  );
  await writeDeliveryEvent(settings.personasRoot, {
    from: sender,
    to: resolved.slug,
    sentAt,
    msgId,
    subject,
    messagePath,
  });

  return {
    ok: true,
    from: sender,
    to: resolved.slug,
    resolved_alias: resolved.alias,
    subject,
    priority,
    sent_at: sentAt,
    msg_id: msgId,
    message_path: messagePath,
  };
}

export function loadPersonaMailSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): PersonaMailSettings {
  const personasRoot = env.PERSONAS_ROOT?.trim();
  if (!personasRoot) {
    throw new Error("PERSONAS_ROOT is required");
  }
  const sender = env.MAILBOX_PERSONA?.trim();
  if (!sender) {
    throw new Error("MAILBOX_PERSONA is required");
  }
  return { personasRoot, sender };
}

async function resolveRecipient(
  rawRecipient: string,
  personasRoot: string,
): Promise<{ slug: string; alias: string | null } | null> {
  const aliases = await buildAliasIndex(personasRoot);
  const normalized = rawRecipient.trim().toLowerCase();
  const exact = aliases.slugByLower.get(normalized);
  if (exact) {
    return { slug: exact, alias: null };
  }
  const aliased = aliases.aliasToSlug.get(normalized);
  if (aliased) {
    return { slug: aliased, alias: rawRecipient.trim() };
  }
  return null;
}

async function buildAliasIndex(personasRoot: string): Promise<{ slugByLower: Map<string, string>; aliasToSlug: Map<string, string> }> {
  const slugByLower = new Map<string, string>();
  const aliasToSlug = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(personasRoot, { withFileTypes: true });
  } catch {
    return { slugByLower, aliasToSlug };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || !isSafeSegment(entry.name)) {
      continue;
    }
    const slug = entry.name;
    slugByLower.set(slug.toLowerCase(), slug);
    for (const alias of await discoverPersonaAliases(personasRoot, slug)) {
      const normalized = alias.trim().toLowerCase();
      if (normalized && !slugByLower.has(normalized) && !aliasToSlug.has(normalized)) {
        aliasToSlug.set(normalized, slug);
      }
    }
  }

  for (const [alias, slug] of Object.entries(DEFAULT_ALIASES)) {
    const existingSlug = slugByLower.get(slug.toLowerCase());
    if (existingSlug && !slugByLower.has(alias) && !aliasToSlug.has(alias)) {
      aliasToSlug.set(alias, existingSlug);
    }
  }

  return { slugByLower, aliasToSlug };
}

async function discoverPersonaAliases(personasRoot: string, slug: string): Promise<string[]> {
  const aliases = new Set<string>();
  for (const relativePath of ["CLAUDE.md", path.join(".claude", "CLAUDE.md")]) {
    let contents = "";
    try {
      contents = await readFile(path.join(personasRoot, slug, relativePath), "utf8");
    } catch {
      continue;
    }
    for (const pattern of [
      /Agent\s*[—-]\s*([A-Za-z][A-Za-z0-9_-]*)/gu,
      /你叫\s*([A-Za-z][A-Za-z0-9_-]*)/gu,
      /自称「([^」]+)」/gu,
    ]) {
      for (const match of contents.matchAll(pattern)) {
        const value = match[1]?.trim();
        if (value && isSafeAlias(value)) {
          aliases.add(value);
        }
      }
    }
  }
  return [...aliases];
}

function renderMailboxFile(input: {
  from: string;
  to: string;
  sentAt: string;
  msgId: string;
  subject: string;
  priority: PersonaMailPriority;
  body: string;
}): string {
  return [
    "---",
    "from: " + input.from,
    "to: " + input.to,
    "sent_at: " + input.sentAt,
    "msg_id: " + input.msgId,
    "status: unread",
    "in_reply_to: " ,
    "subject: " + input.subject,
    "priority: " + input.priority,
    "human_authorized_by: " ,
    "---",
    "# " + input.subject,
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

async function writeDeliveryEvent(
  personasRoot: string,
  input: { from: string; to: string; sentAt: string; msgId: string; subject: string; messagePath: string },
): Promise<void> {
  const dir = path.join(personasRoot, "_shared", "memory", "mailbox", "_events", input.to);
  await mkdir(path.join(dir, "archive"), { recursive: true });
  const eventPath = path.join(dir, safeFilePart(input.msgId) + ".json");
  await writeFile(
    eventPath,
    JSON.stringify(
      {
        event_id: "mailbox:" + input.msgId,
        type: "persona_mail.created",
        from: input.from,
        to: input.to,
        sent_at: input.sentAt,
        msg_id: input.msgId,
        subject: input.subject,
        message_path: input.messagePath,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function normalizePriority(priority: PersonaMailPriority | undefined): PersonaMailPriority {
  return priority && ["P0", "P1", "P2", "P3"].includes(priority) ? priority : "P2";
}

function normalizeSingleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function currentMailboxTimestamp(): string {
  return new Date().toISOString();
}

function compactTimestamp(timestamp: string): string {
  return timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..");
}

function isSafeAlias(value: string): boolean {
  return /^[A-Za-z0-9._ -]+$/.test(value);
}

