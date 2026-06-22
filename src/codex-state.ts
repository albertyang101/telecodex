import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};
type DatabaseReadResult<T> = { ok: true; value: T } | { ok: false };

const SQLITE3_PATH = "/usr/bin/sqlite3";

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  const safeLimit = normalizeLimit(limit);
  const databaseRows = withDatabase((db) => {
    const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE (archived = 0 OR archived IS NULL)
        ORDER BY updated_at DESC
        LIMIT ?
      `);

    return query.all(safeLimit) as ThreadRow[];
  });
  const rows = databaseRows.ok
    ? databaseRows.value
    : querySqliteCli<ThreadRow>(`
      SELECT id, title, cwd, model, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ${safeLimit}
    `);

  return rows?.map(mapThreadRow) ?? [];
}

export function getThread(id: string): CodexThreadRecord | null {
  const databaseRow = withDatabase((db) => {
    const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

    return query.get(id) as ThreadRow | undefined;
  });
  const row = databaseRow.ok
    ? databaseRow.value
    : querySqliteCli<ThreadRow>(`
      SELECT id, title, cwd, model, created_at, updated_at, first_user_message
      FROM threads
      WHERE archived = 0 AND id = ${quoteSqlString(id)}
      LIMIT 1
    `)?.[0];

  return row ? mapThreadRow(row) : null;
}

export function listWorkspaces(): string[] {
  const databaseRows = withDatabase((db) => {
    const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

    return query.all() as WorkspaceRow[];
  });
  const rows = databaseRows.ok
    ? databaseRows.value
    : querySqliteCli<WorkspaceRow>(`
      SELECT DISTINCT cwd
      FROM threads
      WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
      ORDER BY cwd ASC
    `);

  return rows?.map((row) => (typeof row.cwd === "string" ? row.cwd : "")).filter(Boolean) ?? [];
}

/*
 * Codex state listing is UI/control-plane code. Prefer the in-process optional
 * reader, but keep the bridge functional when its native binding is missing.
 */
function querySqliteCli<T>(sql: string): T[] | null {
  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  try {
    const output = execFileSync(SQLITE3_PATH, ["-readonly", "-json", databasePath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const parsed = JSON.parse(output.trim() || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 20;
  }

  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): DatabaseReadResult<T> {
  if (!BetterSqlite3) {
    return { ok: false };
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return { ok: false };
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return { ok: true, value: fn(db) };
  } catch {
    return { ok: false };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getCodexDir(): string | null {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    return codexHome;
  }

  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".codex") : null;
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}
