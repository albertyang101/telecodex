import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

import {
  loadTelegramTransportSettingsFromEnv,
  sendCrossPersonaMessage,
  type SendCrossPersonaMessageInput,
} from "./telegram-transport.js";

const TOOL_NAME = "send_cross_persona_message";

export function createTelegramTransportMcpServer(): Server {
  const server = new Server(
    { name: "telecodex-telegram-transport", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: [
          "Send a text message to another FAMILY persona's Telegram chat.",
          "Use this for family-tenant cross coordination when Albert asks you to message another persona.",
          "Not for dadamia/B2B personas; blocked prefixes return ok=false.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            persona_name: {
              type: "string",
              description: "Family persona directory/name, resolved through state/personas.json.",
            },
            text: {
              type: "string",
              description: "Plain text to send to the target persona chat.",
            },
            task_id: {
              type: "string",
              description: "Optional shared task id; when present the bridge prefixes [TASK <id>].",
            },
          },
          required: ["persona_name", "text"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return toolResult({ ok: false, error: `Unknown tool: ${request.params.name}` }, true);
    }

    const parsed = parseToolArguments(request.params.arguments);
    if (!parsed.ok) {
      return toolResult({ ok: false, error: parsed.error }, true);
    }

    try {
      const settings = loadTelegramTransportSettingsFromEnv();
      const result = await sendCrossPersonaMessage(parsed.input, settings);
      return toolResult(result, false);
    } catch (error) {
      return toolResult(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  });

  return server;
}

function parseToolArguments(args: unknown): { ok: true; input: SendCrossPersonaMessageInput } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be an object" };
  }

  const record = args as Record<string, unknown>;
  const personaName = stringArg(record, "persona_name");
  const text = stringArg(record, "text");
  const taskId = stringArg(record, "task_id");

  if (!personaName) {
    return { ok: false, error: "persona_name is required" };
  }
  if (!text) {
    return { ok: false, error: "text is required" };
  }

  return {
    ok: true,
    input: {
      personaName,
      text,
      taskId,
    },
  };
}

function stringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toolResult(payload: Record<string, unknown>, isError: boolean) {
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
  const server = createTelegramTransportMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
