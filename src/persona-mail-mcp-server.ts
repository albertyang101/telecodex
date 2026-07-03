import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

import {
  loadPersonaMailSettingsFromEnv,
  sendPersonaMail,
  type SendPersonaMailInput,
  type PersonaMailPriority,
} from "./persona-mail.js";

const TOOL_NAME = "send_persona_mail";

export function createPersonaMailMcpServer(): Server {
  const server = new Server(
    { name: "telecodex-persona-mail", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: [
          "Send an internal mailbox message to another Albert persona/agent.",
          "Use real persona slugs or display-name aliases such as vera -> albert-v4.",
          "This is agent-to-agent coordination, not Telegram direct messaging and not durable Memory.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "Recipient persona slug or display-name alias, e.g. albert-v4 or vera.",
            },
            subject: {
              type: "string",
              description: "Mailbox subject. Include [P0]/[P1]/[P2]/[P3] when priority matters.",
            },
            body: {
              type: "string",
              description: "Plain text mailbox body.",
            },
            priority: {
              type: "string",
              enum: ["P0", "P1", "P2", "P3"],
              description: "Optional no-preempt priority. Defaults to P2.",
            },
          },
          required: ["to", "subject", "body"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return toolResult({ ok: false, error: "Unknown tool: " + request.params.name }, true);
    }

    const parsed = parseToolArguments(request.params.arguments);
    if (!parsed.ok) {
      return toolResult({ ok: false, error: parsed.error }, true);
    }

    try {
      const result = await sendPersonaMail(parsed.input, loadPersonaMailSettingsFromEnv());
      return toolResult(result, !result.ok);
    } catch (error) {
      return toolResult(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  });

  return server;
}

function parseToolArguments(args: unknown): { ok: true; input: SendPersonaMailInput } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be an object" };
  }

  const record = args as Record<string, unknown>;
  const to = stringArg(record, "to");
  const subject = stringArg(record, "subject");
  const body = stringArg(record, "body");
  const priority = stringArg(record, "priority") as PersonaMailPriority | undefined;

  if (!to) {
    return { ok: false, error: "to is required" };
  }
  if (!subject) {
    return { ok: false, error: "subject is required" };
  }
  if (!body) {
    return { ok: false, error: "body is required" };
  }
  if (priority && !["P0", "P1", "P2", "P3"].includes(priority)) {
    return { ok: false, error: "priority must be P0, P1, P2, or P3" };
  }

  return { ok: true, input: { to, subject, body, priority } };
}

function stringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toolResult(payload: object, isError: boolean) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

async function main(): Promise<void> {
  const server = createPersonaMailMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

