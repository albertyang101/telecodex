import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

import {
  createLinearEvidenceComment,
  loadLinearControlSettingsFromEnv,
  type CreateLinearEvidenceInput,
} from "./linear-control.js";

const TOOL_NAME = "add_linear_evidence";

export function createLinearControlMcpServer(): Server {
  const server = new Server(
    { name: "telecodex-linear-control", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: [
          "Add typed control-plane evidence to an allowlisted Albert Linear issue.",
          "Use this only for Linear lifecycle checkpoints and live proof evidence.",
          "Use concise non-secret facts; the server formats the Linear comment body.",
          "The dispatcher allowlist decides which ALB issues are writable.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            issue_id: {
              type: "string",
              description: "Allowlisted Linear issue identifier, for example ALB-714.",
            },
            kind: {
              type: "string",
              enum: ["checkpoint", "test", "review", "deploy", "live_verification", "blocker", "handoff"],
              description: "Evidence category.",
            },
            summary: {
              type: "string",
              description: "One concise non-secret sentence summarizing the evidence.",
            },
            evidence: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 20,
              description: "Concrete non-secret evidence bullets.",
            },
            next_step: {
              type: "string",
              description: "Optional concise next step.",
            },
          },
          required: ["issue_id", "kind", "summary", "evidence"],
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
      const result = await createLinearEvidenceComment(parsed.input, loadLinearControlSettingsFromEnv());
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

function parseToolArguments(args: unknown): { ok: true; input: CreateLinearEvidenceInput } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be an object" };
  }

  const record = args as Record<string, unknown>;
  const issueId = stringArg(record, "issue_id");
  const kind = stringArg(record, "kind");
  const summary = stringArg(record, "summary");
  const evidence = stringArrayArg(record, "evidence");
  const nextStep = stringArg(record, "next_step");

  if (!issueId) {
    return { ok: false, error: "issue_id is required" };
  }
  if (!kind) {
    return { ok: false, error: "kind is required" };
  }
  if (!summary) {
    return { ok: false, error: "summary is required" };
  }
  if (!evidence) {
    return { ok: false, error: "evidence must be a non-empty string array" };
  }

  return {
    ok: true,
    input: {
      issueId,
      kind: kind as CreateLinearEvidenceInput["kind"],
      summary,
      evidence,
      nextStep,
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

function stringArrayArg(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((item) => (typeof item === "string" ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
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
  const server = createLinearControlMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
