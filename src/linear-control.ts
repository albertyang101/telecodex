import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const MAX_COMMENT_BODY_LENGTH = 20_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_TEXT_LENGTH = 1_000;
const LINEAR_EVIDENCE_KIND_LABELS = {
  checkpoint: "Checkpoint",
  test: "Test",
  review: "Review",
  deploy: "Deploy",
  live_verification: "Live Verification",
  blocker: "Blocker",
  handoff: "Handoff",
} as const;
const SECRET_LOOKING_PATTERNS = [
  /\b(?:api[_-]?key|token|secret|authorization|password)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
];

export interface LinearControlSettings {
  allowedIssues: string[];
  apiKeyPath: string;
}

export interface CreateLinearCommentInput {
  issueId: string;
  body: string;
}

export type LinearEvidenceKind = keyof typeof LINEAR_EVIDENCE_KIND_LABELS;

export interface CreateLinearEvidenceInput {
  issueId: string;
  kind: LinearEvidenceKind;
  summary: string;
  evidence: string[];
  nextStep?: string;
}

export interface CreateLinearCommentResult {
  ok: true;
  issueIdentifier: string;
  issueUrl?: string;
  commentId?: string;
  commentUrl?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ISSUE_QUERY = `
query LinearIssueForComment($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
  }
}
`;

const CREATE_COMMENT_MUTATION = `
mutation CreateLinearComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment {
      id
      url
    }
  }
}
`;

export function loadLinearControlSettingsFromEnv(): LinearControlSettings {
  return {
    allowedIssues: parseAllowedIssues(process.env.LINEAR_CONTROL_ALLOWED_ISSUES),
    apiKeyPath:
      optionalString(process.env.LINEAR_API_KEY_PATH) ??
      path.join(homedir(), ".config", "linear", "api_key"),
  };
}

export async function createLinearEvidenceComment(
  input: CreateLinearEvidenceInput,
  settings: LinearControlSettings,
  fetcher: FetchLike = fetch,
): Promise<CreateLinearCommentResult> {
  return createLinearComment(
    {
      issueId: input.issueId,
      body: formatLinearEvidenceBody(input),
    },
    settings,
    fetcher,
  );
}

export async function createLinearComment(
  input: CreateLinearCommentInput,
  settings: LinearControlSettings,
  fetcher: FetchLike = fetch,
): Promise<CreateLinearCommentResult> {
  const issueId = normalizeIssueId(input.issueId);
  const body = normalizeBody(input.body);
  ensureIssueAllowed(issueId, settings.allowedIssues);
  const apiKey = resolveApiKey(settings);

  const issueData = await linearGraphQl<{ issue: { id: string; identifier: string; url?: string } | null }>(
    apiKey,
    ISSUE_QUERY,
    { id: issueId },
    fetcher,
  );
  const issue = issueData.issue;
  if (!issue) {
    throw new Error(`Linear issue not found: ${issueId}`);
  }

  const commentData = await linearGraphQl<{
    commentCreate: { success: boolean; comment?: { id?: string; url?: string } | null };
  }>(
    apiKey,
    CREATE_COMMENT_MUTATION,
    { issueId: issue.id, body },
    fetcher,
  );
  if (!commentData.commentCreate?.success) {
    throw new Error(`Linear commentCreate did not report success for ${issueId}`);
  }

  return {
    ok: true,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    ...(commentData.commentCreate.comment?.id ? { commentId: commentData.commentCreate.comment.id } : {}),
    ...(commentData.commentCreate.comment?.url ? { commentUrl: commentData.commentCreate.comment.url } : {}),
  };
}

function formatLinearEvidenceBody(input: CreateLinearEvidenceInput): string {
  const kind = normalizeEvidenceKind(input.kind);
  const summary = normalizeEvidenceText(input.summary, "summary");
  const evidence = normalizeEvidenceItems(input.evidence);
  const nextStep = input.nextStep === undefined
    ? undefined
    : normalizeEvidenceText(input.nextStep, "nextStep");

  return [
    `### ${LINEAR_EVIDENCE_KIND_LABELS[kind]} Evidence`,
    "",
    `Summary: ${summary}`,
    "",
    "Evidence:",
    ...evidence.map((item) => `- ${item}`),
    ...(nextStep ? ["", `Next step: ${nextStep}`] : []),
  ].join("\n");
}

function parseAllowedIssues(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeIssueId(raw: string): string {
  const issueId = raw.trim().toUpperCase();
  if (!/^ALB-\d+$/.test(issueId)) {
    throw new Error(`Invalid Linear issue id: ${raw}`);
  }
  return issueId;
}

function normalizeBody(raw: string): string {
  const body = raw.trim();
  if (!body) {
    throw new Error("Linear comment body is required");
  }
  if (body.length > MAX_COMMENT_BODY_LENGTH) {
    throw new Error(`Linear comment body exceeds ${MAX_COMMENT_BODY_LENGTH} characters`);
  }
  return body;
}

function ensureIssueAllowed(issueId: string, allowedIssues: string[]): void {
  if (!allowedIssues.includes(issueId)) {
    throw new Error(`Linear issue ${issueId} is not allowlisted`);
  }
}

function normalizeEvidenceKind(raw: string): LinearEvidenceKind {
  if (Object.prototype.hasOwnProperty.call(LINEAR_EVIDENCE_KIND_LABELS, raw)) {
    return raw as LinearEvidenceKind;
  }
  throw new Error(`Invalid Linear evidence kind: ${raw}`);
}

function normalizeEvidenceItems(raw: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Linear evidence must include at least one item");
  }
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    throw new Error(`Linear evidence cannot include more than ${MAX_EVIDENCE_ITEMS} items`);
  }
  return raw.map((item, index) => normalizeEvidenceText(item, `evidence[${index}]`));
}

function normalizeEvidenceText(raw: string, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`Linear evidence ${fieldName} must be a string`);
  }
  const text = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    throw new Error(`Linear evidence ${fieldName} is required`);
  }
  if (text.length > MAX_EVIDENCE_TEXT_LENGTH) {
    throw new Error(`Linear evidence ${fieldName} exceeds ${MAX_EVIDENCE_TEXT_LENGTH} characters`);
  }
  if (SECRET_LOOKING_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("Linear evidence contains secret-looking content");
  }
  return text;
}

function resolveApiKey(settings: LinearControlSettings): string {
  if (existsSync(settings.apiKeyPath)) {
    const key = readFileSync(settings.apiKeyPath, "utf8").trim();
    if (key) {
      return key;
    }
  }
  throw new Error("Linear API key is not configured");
}

async function linearGraphQl<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetcher: FetchLike,
): Promise<TData> {
  const response = await fetcher(DEFAULT_LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear GraphQL HTTP ${response.status}`);
  }

  const payload = await response.json() as { data?: TData; errors?: unknown };
  if (payload.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(payload.errors)}`);
  }
  if (!payload.data) {
    throw new Error("Linear GraphQL response missing data");
  }
  return payload.data;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
