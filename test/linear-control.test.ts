import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createLinearEvidenceComment,
  createLinearComment,
  loadLinearControlSettingsFromEnv,
  type LinearControlSettings,
} from "../src/linear-control.js";

describe("Linear control helper", () => {
  let tempDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-linear-"));
    process.env = { ...originalEnv };
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY_PATH;
    delete process.env.LINEAR_CONTROL_ALLOWED_ISSUES;
    delete process.env.LINEAR_GRAPHQL_URL;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  const settings = (overrides: Partial<LinearControlSettings> = {}): LinearControlSettings => {
    const apiKeyPath = path.join(tempDir, "api_key");
    writeFileSync(apiKeyPath, "linear-key\n");
    return {
      allowedIssues: ["ALB-714"],
      apiKeyPath,
      ...overrides,
    };
  };

  it("reads settings from env without exposing the API key or accepting endpoint overrides", () => {
    const keyPath = path.join(tempDir, "api_key");
    process.env.LINEAR_API_KEY = "env-key";
    process.env.LINEAR_API_KEY_PATH = keyPath;
    process.env.LINEAR_CONTROL_ALLOWED_ISSUES = "ALB-714, ALB-722";
    process.env.LINEAR_GRAPHQL_URL = "https://poisoned.example/graphql";

    expect(loadLinearControlSettingsFromEnv()).toEqual({
      allowedIssues: ["ALB-714", "ALB-722"],
      apiKeyPath: keyPath,
    });
  });

  it("returns the created comment id and url after creating a comment", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, init, body });
      if (body.query.includes("query LinearIssueForComment")) {
        return jsonResponse({
          data: {
            issue: {
              id: "issue-uuid",
              identifier: "ALB-714",
              url: "https://linear.app/albert-yang/issue/ALB-714/test",
            },
          },
        });
      }
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-uuid",
              url: "https://linear.app/albert-yang/issue/ALB-714/test#comment-uuid",
            },
          },
        },
      });
    });

    const result = await createLinearComment(
      { issueId: "ALB-714", body: "probe body" },
      settings(),
      fetcher,
    );

    expect(result).toEqual({
      ok: true,
      issueIdentifier: "ALB-714",
      issueUrl: "https://linear.app/albert-yang/issue/ALB-714/test",
      commentId: "comment-uuid",
      commentUrl: "https://linear.app/albert-yang/issue/ALB-714/test#comment-uuid",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linear.app/graphql",
      "https://api.linear.app/graphql",
    ]);
    expect(calls[0].body.variables).toEqual({ id: "ALB-714" });
    expect(calls[1].body.variables).toEqual({ issueId: "issue-uuid", body: "probe body" });
    expect(calls[1].body.query).toContain("comment {");
    expect(calls[1].body.query).toContain("id");
    expect(calls[1].body.query).toContain("url");
    expect(calls[0].init.headers).toEqual(
      expect.objectContaining({
        Authorization: "linear-key",
        "Content-Type": "application/json",
      }),
    );
  });

  it("reads the API key only from the configured file", async () => {
    const keyPath = path.join(tempDir, "api_key");
    writeFileSync(keyPath, "file-key\n");
    process.env.LINEAR_API_KEY = "env-key";
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toBe("file-key");
      const body = JSON.parse(String(init.body));
      if (body.query.includes("query LinearIssueForComment")) {
        return jsonResponse({ data: { issue: { id: "issue-uuid", identifier: "ALB-714", url: "url" } } });
      }
      return jsonResponse({ data: { commentCreate: { success: true } } });
    });

    await createLinearComment(
      { issueId: "ALB-714", body: "probe body" },
      {
        allowedIssues: ["ALB-714"],
        apiKeyPath: keyPath,
      },
      fetcher,
    );
  });

  it("creates typed evidence comments instead of accepting raw auto-approved markdown", async () => {
    const calls: Array<{ body: any }> = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ body });
      if (body.query.includes("query LinearIssueForComment")) {
        return jsonResponse({
          data: {
            issue: {
              id: "issue-uuid",
              identifier: "ALB-714",
              url: "https://linear.app/albert-yang/issue/ALB-714/test",
            },
          },
        });
      }
      return jsonResponse({ data: { commentCreate: { success: true } } });
    });

    await createLinearEvidenceComment(
      {
        issueId: "ALB-714",
        kind: "live_verification",
        summary: "THEO wrote Linear evidence through the scoped MCP.",
        evidence: [
          "Telegram reply id 26032 returned the exact nonce.",
          "Session JSONL shows mcp__linear_control.add_linear_evidence ok=true.",
        ],
        nextStep: "Keep ALB-714 open until lifecycle discipline is verified.",
      },
      settings(),
      fetcher,
    );

    expect(calls[1].body.variables.body).toBe(
      [
        "### Live Verification Evidence",
        "",
        "Summary: THEO wrote Linear evidence through the scoped MCP.",
        "",
        "Evidence:",
        "- Telegram reply id 26032 returned the exact nonce.",
        "- Session JSONL shows mcp__linear_control.add_linear_evidence ok=true.",
        "",
        "Next step: Keep ALB-714 open until lifecycle discipline is verified.",
      ].join("\n"),
    );
  });

  it("rejects secret-looking evidence before network calls", async () => {
    const fetcher = vi.fn();

    await expect(
      createLinearEvidenceComment(
        {
          issueId: "ALB-714",
          kind: "checkpoint",
          summary: "Authorization: Bearer leaked-token",
          evidence: ["probe"],
        },
        settings(),
        fetcher,
      ),
    ).rejects.toThrow("Linear evidence contains secret-looking content");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects issues outside the allowlist before network calls", async () => {
    const fetcher = vi.fn();

    await expect(
      createLinearComment({ issueId: "ALB-999", body: "probe body" }, settings(), fetcher),
    ).rejects.toThrow("Linear issue ALB-999 is not allowlisted");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects empty comments before network calls", async () => {
    const fetcher = vi.fn();

    await expect(
      createLinearComment({ issueId: "ALB-714", body: " " }, settings(), fetcher),
    ).rejects.toThrow("Linear comment body is required");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
