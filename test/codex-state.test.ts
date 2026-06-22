import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

type ThreadFixture = {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  first_user_message: string;
  archived?: number;
};

type LoadOptions = {
  home?: string;
  codexHome?: string;
  files?: string[];
  stats?: Record<string, number>;
  threads?: ThreadFixture[];
  modelsJson?: string;
  betterSqliteAvailable?: boolean;
  openThrows?: boolean;
  sqliteCliOutput?: string;
  sqliteCliThrows?: boolean;
};

const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("better-sqlite3");
  vi.resetModules();
  mockExecFileSync.mockReset();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

async function loadCodexState(options: LoadOptions = {}) {
  const home = options.home ?? "/Users/tester";
  const configuredCodexHome = options.codexHome?.trim();
  const codexDir = configuredCodexHome || path.join(home, ".codex");
  const modelsPath = path.join(codexDir, "models_cache.json");
  const files = options.files ?? [];
  const stats = options.stats ?? {};
  const threads = options.threads ?? [];
  process.env.HOME = home;
  if (options.codexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = options.codexHome;
  }

  vi.resetModules();
  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation(() => {
    if (options.sqliteCliThrows) {
      throw new Error("sqlite3 failed");
    }

    return options.sqliteCliOutput ?? "[]";
  });

  vi.doMock("node:fs", () => ({
    existsSync: vi.fn((targetPath: string) => {
      if (targetPath === codexDir) {
        return true;
      }
      if (targetPath === modelsPath) {
        return options.modelsJson !== undefined;
      }
      return files.includes(path.basename(targetPath));
    }),
    readdirSync: vi.fn((targetPath: string) => {
      if (targetPath !== codexDir) {
        throw new Error(`Unexpected readdirSync path: ${targetPath}`);
      }
      return files;
    }),
    statSync: vi.fn((targetPath: string) => ({
      mtimeMs: stats[targetPath] ?? 0,
    })),
    readFileSync: vi.fn((targetPath: string) => {
      if (targetPath !== modelsPath || options.modelsJson === undefined) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return options.modelsJson;
    }),
  }));

  if (options.betterSqliteAvailable === false) {
    vi.doMock("better-sqlite3", () => {
      throw Object.assign(new Error("Cannot find package 'better-sqlite3'"), { code: "ERR_MODULE_NOT_FOUND" });
    });
  } else {
    vi.doMock("better-sqlite3", () => ({
      default: class MockDatabase {
        constructor(_databasePath: string) {
          if (options.openThrows) {
            throw new Error("open failed");
          }
        }

        prepare(sql: string) {
          return {
            all: (...args: unknown[]) => runAllQuery(sql, threads, args),
            get: (...args: unknown[]) => runGetQuery(sql, threads, args),
          };
        }

        close(): void {}
      },
    }));
  }

  return await import("../src/codex-state.js");
}

function runAllQuery(sql: string, threads: ThreadFixture[], args: unknown[]) {
  if (sql.includes("SELECT DISTINCT cwd")) {
    return [...new Set(threads.filter((thread) => thread.archived !== 1).map((thread) => thread.cwd).filter(Boolean))]
      .sort()
      .map((cwd) => ({ cwd }));
  }

  if (sql.includes("FROM threads")) {
    const limit = typeof args[0] === "number" ? args[0] : 20;
    return threads
      .filter((thread) => thread.archived !== 1)
      .sort((left, right) => right.updated_at - left.updated_at)
      .slice(0, limit);
  }

  return [];
}

function runGetQuery(sql: string, threads: ThreadFixture[], args: unknown[]) {
  if (sql.includes("WHERE archived = 0 AND id = ?")) {
    const id = String(args[0] ?? "");
    return threads.find((thread) => thread.archived !== 1 && thread.id === id);
  }

  return undefined;
}

describe("codex-state", () => {
  it("findLatestDatabase returns null when no sqlite files exist", async () => {
    const state = await loadCodexState({ files: [] });

    expect(state.findLatestDatabase()).toBeNull();
  });

  it("findLatestDatabase returns the newest matching sqlite file", async () => {
    const home = "/Users/tester";
    const codexDir = path.join(home, ".codex");
    const older = path.join(codexDir, "state_old.sqlite");
    const newer = path.join(codexDir, "state_new.sqlite");
    const state = await loadCodexState({
      home,
      files: ["notes.txt", "state_old.sqlite", "state_new.sqlite"],
      stats: {
        [older]: 100,
        [newer]: 200,
      },
    });

    expect(state.findLatestDatabase()).toBe(newer);
  });

  it("findLatestDatabase prefers CODEX_HOME over HOME .codex", async () => {
    const home = "/Users/tester";
    const codexHome = "/runtime/codex-home";
    const statePath = path.join(codexHome, "state_runtime.sqlite");
    const state = await loadCodexState({
      home,
      codexHome,
      files: ["state_runtime.sqlite"],
      stats: {
        [statePath]: 100,
      },
    });

    expect(state.findLatestDatabase()).toBe(statePath);
  });

  it("findLatestDatabase falls back to HOME .codex when CODEX_HOME is blank", async () => {
    const home = "/Users/tester";
    const codexDir = path.join(home, ".codex");
    const statePath = path.join(codexDir, "state_home.sqlite");
    const state = await loadCodexState({
      home,
      codexHome: "   ",
      files: ["state_home.sqlite"],
      stats: {
        [statePath]: 100,
      },
    });

    expect(state.findLatestDatabase()).toBe(statePath);
  });

  it("listThreads returns an empty array when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({ betterSqliteAvailable: false, files: ["state_main.sqlite"] });

    expect(state.listThreads()).toEqual([]);
  });

  it("getThread reads Codex state through sqlite3 CLI when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({
      betterSqliteAvailable: false,
      files: ["state_main.sqlite"],
      sqliteCliOutput: JSON.stringify([
        {
          id: "019eeed3-cdb6-7271-b597-337fc266709f",
          title: "Lifecycle",
          cwd: "/workspace/lifecycle",
          model: "gpt-5.5",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_100,
          first_user_message: "ready",
        },
      ]),
    });

    expect(state.getThread("019eeed3-cdb6-7271-b597-337fc266709f")).toEqual({
      id: "019eeed3-cdb6-7271-b597-337fc266709f",
      title: "Lifecycle",
      cwd: "/workspace/lifecycle",
      model: "gpt-5.5",
      createdAt: new Date(1_700_000_000 * 1000),
      updatedAt: new Date(1_700_000_100 * 1000),
      firstUserMessage: "ready",
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/sqlite3",
      expect.arrayContaining(["-json", expect.stringContaining("state_main.sqlite")]),
      expect.any(Object),
    );
  });

  it("getThread does not use sqlite3 CLI when better-sqlite3 successfully finds no row", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      sqliteCliOutput: JSON.stringify([
        {
          id: "missing",
          title: "Wrong source",
          cwd: "/workspace/wrong",
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "wrong",
        },
      ]),
    });

    expect(state.getThread("missing")).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("getThread escapes ids when querying through sqlite3 CLI", async () => {
    const state = await loadCodexState({
      betterSqliteAvailable: false,
      files: ["state_main.sqlite"],
      sqliteCliOutput: "[]",
    });

    expect(state.getThread("thread'abc")).toBeNull();
    const sqliteArgs = mockExecFileSync.mock.calls[0]?.[1] as string[];
    expect(sqliteArgs).toContain("-readonly");
    expect(sqliteArgs).toContain("-json");
    expect(sqliteArgs.at(-1)).toContain("id = 'thread''abc'");
  });

  it("listThreads reads Codex state through sqlite3 CLI when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({
      betterSqliteAvailable: false,
      files: ["state_main.sqlite"],
      sqliteCliOutput: JSON.stringify([
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace/a",
          model: "gpt-5.5",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_100,
          first_user_message: "one",
        },
      ]),
    });

    expect(state.listThreads(5)).toEqual([
      {
        id: "thread-1",
        title: "One",
        cwd: "/workspace/a",
        model: "gpt-5.5",
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_100 * 1000),
        firstUserMessage: "one",
      },
    ]);
    const sqliteArgs = mockExecFileSync.mock.calls[0]?.[1] as string[];
    expect(sqliteArgs.at(-1)).toContain("LIMIT 5");
  });

  it("listWorkspaces reads Codex state through sqlite3 CLI when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({
      betterSqliteAvailable: false,
      files: ["state_main.sqlite"],
      sqliteCliOutput: JSON.stringify([{ cwd: "/workspace/a" }, { cwd: "/workspace/b" }]),
    });

    expect(state.listWorkspaces()).toEqual(["/workspace/a", "/workspace/b"]);
  });

  it("listThreads returns mapped active thread records", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "Newest",
          cwd: "/workspace/b",
          model: "gpt-5.4",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_200,
          first_user_message: "hello",
        },
        {
          id: "thread-2",
          title: "Archived",
          cwd: "/workspace/c",
          model: "o3",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_300,
          first_user_message: "hidden",
          archived: 1,
        },
        {
          id: "thread-3",
          title: "Older",
          cwd: "/workspace/a",
          model: null,
          created_at: 1_700_000_000,
          updated_at: 1_700_000_100,
          first_user_message: "older",
        },
      ],
    });

    expect(state.listThreads(10)).toEqual([
      {
        id: "thread-1",
        title: "Newest",
        cwd: "/workspace/b",
        model: "gpt-5.4",
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_200 * 1000),
        firstUserMessage: "hello",
      },
      {
        id: "thread-3",
        title: "Older",
        cwd: "/workspace/a",
        model: null,
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_100 * 1000),
        firstUserMessage: "older",
      },
    ]);
  });

  it("listWorkspaces returns unique sorted active workspaces", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 2,
          first_user_message: "one",
        },
        {
          id: "thread-2",
          title: "Two",
          cwd: "/workspace/a",
          model: "o3",
          created_at: 1,
          updated_at: 3,
          first_user_message: "two",
        },
        {
          id: "thread-3",
          title: "Three",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 4,
          first_user_message: "three",
        },
        {
          id: "thread-4",
          title: "Archived",
          cwd: "/workspace/b",
          model: "o3",
          created_at: 1,
          updated_at: 5,
          first_user_message: "archived",
          archived: 1,
        },
      ],
    });

    expect(state.listWorkspaces()).toEqual(["/workspace/a", "/workspace/z"]);
  });

  it("listModels parses models_cache.json and filters hidden models", async () => {
    const state = await loadCodexState({
      modelsJson: JSON.stringify({
        models: [
          { slug: "gpt-5.4", display_name: "GPT-5.4" },
          { slug: "secret", display_name: "Secret", visibility: "hidden" },
          { slug: "o3", display_name: "o3", visibility: "public" },
        ],
      }),
    });

    expect(state.listModels()).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);
  });

  it("listModels falls back when models_cache.json is absent or invalid", async () => {
    const noFileState = await loadCodexState();
    expect(noFileState.listModels()).toEqual(noFileState.FALLBACK_MODELS);

    const invalidState = await loadCodexState({ modelsJson: "{not-json" });
    expect(invalidState.listModels()).toEqual(invalidState.FALLBACK_MODELS);
  });

  it("getThread returns null when not found", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], threads: [] });

    expect(state.getThread("missing")).toBeNull();
  });

  it("returns empty results gracefully when opening the database fails", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], openThrows: true });

    expect(state.listThreads()).toEqual([]);
    expect(state.listWorkspaces()).toEqual([]);
    expect(state.getThread("thread-1")).toBeNull();
  });
});
