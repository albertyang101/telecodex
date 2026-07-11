import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const hookScript = fileURLToPath(new URL("../scripts/codex-pre-tool-use-policy.py", import.meta.url));

function runHook(
  command: string,
  options: {
    turnId?: string;
    sessionId?: string;
    cwd?: string;
    stateDir?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    graphifyBin?: string;
    graphRoot?: string;
    repoMapFile?: string;
  } = {},
) {
  return spawnSync("/usr/bin/python3", [hookScript], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: options.toolName ?? "Bash",
      tool_input: options.toolInput ?? { command },
      session_id: options.sessionId ?? "session-default",
      turn_id: options.turnId ?? "turn-default",
      cwd: options.cwd ?? "/tmp/non-code-task",
    }),
    env: {
      ...process.env,
      CODEX_GRAPHIFY_GATE_STATE_DIR:
        options.stateDir ?? join(tmpdir(), "codex-graphify-gate-unused"),
      ...(options.graphifyBin ? { CODEX_GRAPHIFY_BIN: options.graphifyBin } : {}),
      ...(options.graphRoot ? { CODEX_GRAPHIFY_GRAPH_ROOT: options.graphRoot } : {}),
      ...(options.repoMapFile ? { CODEX_GRAPHIFY_REPO_MAP_FILE: options.repoMapFile } : {}),
    },
    encoding: "utf8",
  });
}

function executeGraphify(
  command: string,
  options: Parameters<typeof runHook>[1],
) {
  const pre = runHook(command, options);
  if (pre.status !== 0 || !pre.stdout) return pre;
  const rewritten = JSON.parse(pre.stdout).hookSpecificOutput.updatedInput.command;
  return spawnSync("/bin/zsh", ["-lc", rewritten], {
    cwd: options.cwd,
    env: {
      ...process.env,
      CODEX_GRAPHIFY_GATE_STATE_DIR: options.stateDir,
      ...(options.graphifyBin ? { CODEX_GRAPHIFY_BIN: options.graphifyBin } : {}),
      ...(options.graphRoot ? { CODEX_GRAPHIFY_GRAPH_ROOT: options.graphRoot } : {}),
      ...(options.repoMapFile ? { CODEX_GRAPHIFY_REPO_MAP_FILE: options.repoMapFile } : {}),
    },
    encoding: "utf8",
  });
}

describe("codex PreToolUse policy hook", () => {
  it("blocks code commands until the same session and turn completes a real shared graph query", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const options = {
      sessionId: "session-code",
      turnId: "turn-code",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      const blocked = runHook("rg -n createBot src test", options);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("query the canonical shared graph first");

      const graph = runHook(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(graph.status).toBe(0);
      const rewritten = JSON.parse(graph.stdout).hookSpecificOutput.updatedInput.command;
      expect(
        spawnSync("/bin/zsh", ["-lc", rewritten], {
          cwd: options.cwd,
          env: {
            ...process.env,
            CODEX_GRAPHIFY_GATE_STATE_DIR: stateDir,
          },
          encoding: "utf8",
        }).status,
      ).toBe(0);

      const allowed = runHook("rg -n createBot src test", options);
      expect(allowed.status).toBe(0);
      expect(
        runHook(
          "rg -n createBot src && sed -n 330,370p src/bot.ts",
          options,
        ).status,
      ).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });



  it("requires explain after a broad query before source inspection", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-query-explain-"));
    const options = {
      sessionId: "session-query-explain",
      turnId: "turn-query-explain",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      expect(executeGraphify(
        "~/.local/bin/graphify query 'legacy prompt guard' --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);

      const afterQuery = runHook("sed -n 1,80p src/prompt-guard.ts", options);
      expect(afterQuery.status).not.toBe(0);
      expect(afterQuery.stderr).toContain("explain");

      expect(executeGraphify(
        "~/.local/bin/graphify explain LEGACY_PROMPT_GUARD_LINES --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("sed -n 1,80p src/prompt-guard.ts", options).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });


  it("does not unlock source when graphify reports a missing explain node", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-missing-explain-"));
    const options = {
      sessionId: "session-missing-explain",
      turnId: "turn-missing-explain",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      const missing = executeGraphify(
        "~/.local/bin/graphify explain __definitely_missing_review_node__ --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toContain("No node matching");
      expect(runHook("sed -n 1,40p src/bot.ts", options).status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a fuzzy explain result that is not the exact requested node", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-fuzzy-explain-"));
    const options = {
      sessionId: "session-fuzzy-explain",
      turnId: "turn-fuzzy-explain",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      const fuzzy = executeGraphify(
        "~/.local/bin/graphify explain LEGACY_PROMPT_GUARD --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(fuzzy.status).not.toBe(0);
      expect(fuzzy.stdout).toContain("Node: LEGACY_PROMPT_GUARD_LINES");
      expect(runHook("sed -n 1,40p src/prompt-guard.ts", options).status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts a uniquely resolved affected node with no downstream impact", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-empty-affected-"));
    const options = {
      sessionId: "session-empty-affected",
      turnId: "turn-empty-affected",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify explain launchd_start --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      const affected = executeGraphify(
        "~/.local/bin/graphify affected launchd_start --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(affected.status).toBe(0);
      expect(affected.stdout).toContain("No affected nodes found.");
      expect(runHook("", {
        ...options,
        toolName: "apply_patch",
        toolInput: { file_path: "scripts/start.sh", patch: "*** Begin Patch" },
      }).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires separate successful explain and affected receipts before edits", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-independent-receipts-"));
    const options = {
      sessionId: "session-independent-receipts",
      turnId: "turn-independent-receipts",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify affected LEGACY_PROMPT_GUARD_LINES --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("sed -n 1,40p src/prompt-guard.ts", options).status).not.toBe(0);
      expect(runHook("", {
        ...options,
        toolName: "apply_patch",
        toolInput: { file_path: "src/prompt-guard.ts", patch: "*** Begin Patch" },
      }).status).not.toBe(0);

      expect(executeGraphify(
        "~/.local/bin/graphify explain LEGACY_PROMPT_GUARD_LINES --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("sed -n 1,40p src/prompt-guard.ts", options).status).toBe(0);
      expect(runHook("", {
        ...options,
        toolName: "apply_patch",
        toolInput: { file_path: "src/prompt-guard.ts", patch: "*** Begin Patch" },
      }).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not record affected when graphify cannot resolve a unique node", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-missing-affected-"));
    const options = {
      sessionId: "session-missing-affected",
      turnId: "turn-missing-affected",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify explain LEGACY_PROMPT_GUARD_LINES --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      const missing = executeGraphify(
        "~/.local/bin/graphify affected __definitely_missing_review_node__ --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toContain("No unique node match");
      expect(runHook("", {
        ...options,
        toolName: "apply_patch",
        toolInput: { file_path: "src/prompt-guard.ts", patch: "*** Begin Patch" },
      }).status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("binds shell relative paths and real apply_patch bodies to the target repository", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-relative-cross-repo-"));
    const options = {
      sessionId: "session-relative-cross-repo",
      turnId: "turn-relative-cross-repo",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(executeGraphify(
        "~/.local/bin/graphify affected createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);

      const relative = runHook(
        "sed -n 1,20p ../../claude/app/telegram_bot.py",
        options,
      );
      expect(relative.status).not.toBe(0);
      expect(relative.stderr).toContain("claude-canonical");

      const patchBody = runHook("", {
        ...options,
        toolName: "apply_patch",
        toolInput: {
          command: "*** Begin Patch\n*** Update File: /Users/albertyang0888/code/claude/app/telegram_bot.py\n@@\n-old\n+new\n*** End Patch",
        },
      });
      expect(patchBody.status).not.toBe(0);
      expect(patchBody.stderr).toContain("claude-canonical");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows filesystem reads after explain but requires affected for filesystem writes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-filesystem-"));
    const options = {
      sessionId: "session-filesystem",
      turnId: "turn-filesystem",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("", {
        ...options,
        toolName: "mcp__filesystem__read_text_file",
        toolInput: { path: "src/bot.ts" },
      }).status).toBe(0);
      expect(runHook("", {
        ...options,
        toolName: "mcp__filesystem__write_file",
        toolInput: { path: "src/bot.ts", content: "x" },
      }).status).not.toBe(0);

      expect(executeGraphify(
        "~/.local/bin/graphify affected createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("", {
        ...options,
        toolName: "mcp__filesystem__write_file",
        toolInput: { path: "src/bot.ts", content: "x" },
      }).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
  it("does not accept a graphify-looking string that was not executed", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const options = {
      sessionId: "session-fake",
      turnId: "turn-fake",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      const fake = runHook(
        "echo ~/.local/bin/graphify query createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(fake.status).not.toBe(0);

      const blocked = runHook("sed -n 1,80p src/bot.ts", options);
      expect(blocked.status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not unlock one repository with another repository graph", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const options = {
      sessionId: "session-wrong-repo",
      turnId: "turn-wrong-repo",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      const wrongGraph = runHook(
        "~/.local/bin/graphify query dispatcher --graph ~/personas/_shared/graphify/graphs/claude-canonical/graph.json",
        options,
      );
      expect(wrongGraph.status).not.toBe(0);

      const blocked = runHook("rg -n createBot src", options);
      expect(blocked.status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a graph query across turns or sessions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const common = {
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      expect(
        runHook(
          "~/.local/bin/graphify query typing --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
          { ...common, sessionId: "session-one", turnId: "turn-one" },
        ).status,
      ).toBe(0);

      expect(
        runHook("sed -n 1,80p src/bot.ts", {
          ...common,
          sessionId: "session-one",
          turnId: "turn-two",
        }).status,
      ).not.toBe(0);
      expect(
        runHook("sed -n 1,80p src/bot.ts", {
          ...common,
          sessionId: "session-two",
          turnId: "turn-one",
        }).status,
      ).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recognizes canonical graph aliases for code repositories", () => {
    const result = runHook("rg -n dispatcher src", {
      sessionId: "session-claude",
      turnId: "turn-claude",
      cwd: "/Users/albertyang0888/code/claude",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("query the canonical shared graph first");
  });

  it("allows reading the overlay SKILL.md even when its path contains graphify", () => {
    const result = runHook(
      "sed -n 1,120p /private/tmp/codex-graphify-skill/SKILL.md",
      {
        sessionId: "session-skill-read",
        turnId: "turn-skill-read",
        cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      },
    );

    expect(result.status).toBe(0);
  });

  it("allows only standalone control-document reads before graphify", () => {
    const common = {
      sessionId: "session-docs",
      turnId: "turn-docs",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
    };

    expect(runHook("sed -n 1,80p AGENTS.md", common).status).toBe(0);
    expect(runHook("cat AGENTS.md Makefile scripts/tool.rb", common).status).not.toBe(0);
    expect(runHook("cat AGENTS.md; rg -n dispatcher src", common).status).not.toBe(0);
  });

  it.each([
    "/usr/bin/sed -n 1,80p src/bot.ts",
    "python3 -c 'open(chr(115)+chr(114)+chr(99)+chr(47)+chr(98)+chr(111)+chr(116)+chr(46)+chr(116)+chr(115)).read()'",
    "printf x > src/bot.ts",
    "cp /tmp/x src/bot.ts",
    "rm src/bot.ts",
    "nl -ba src/bot.ts",
    "git blame src/bot.ts",
    "tee src/bot.ts",
  ])("blocks alternate code access before graphify: %s", (command) => {
    const result = runHook(command, {
      sessionId: "session-alt",
      turnId: "turn-alt",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("query the canonical shared graph first");
  });

  it("rejects masquerading executables in pre-graph exemptions", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-masquerade-"));
    const fakeCat = join(fixture, "cat");
    const fakeLs = join(fixture, "ls");
    writeFileSync(fakeCat, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    writeFileSync(fakeLs, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    const options = {
      sessionId: "session-masquerade",
      turnId: "turn-masquerade",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
    };
    try {
      expect(runHook(fakeCat + " AGENTS.md", options).status).not.toBe(0);
      expect(runHook(fakeLs + " /Users/albertyang0888/personas/_shared/graphify/graphs", options).status).not.toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects extensionless non-control operands beside a control document", () => {
    const result = runHook("/bin/cat AGENTS.md Makefile", {
      sessionId: "session-extensionless",
      turnId: "turn-extensionless",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
    });
    expect(result.status).not.toBe(0);
  });

  it("gates absolute repository targets from outside the repository", () => {
    const result = runHook(
      "/bin/cat /Users/albertyang0888/code/codex-telegram-research/telecodex/src/bot.ts",
      { sessionId: "session-absolute", turnId: "turn-absolute", cwd: "/tmp" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("query the canonical shared graph first");
  });

  it("binds every edit target to its own repository graph", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-cross-repo-"));
    const common = {
      sessionId: "session-cross-repo",
      turnId: "turn-cross-repo",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(runHook(
        "~/.local/bin/graphify affected createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      const edit = runHook("", {
        ...common,
        toolName: "apply_patch",
        toolInput: {
          file_path: "/Users/albertyang0888/code/claude/app/telegram_bot.py",
          patch: "*** Begin Patch",
        },
      });
      expect(edit.status).not.toBe(0);
      expect(edit.stderr).toContain("claude-canonical");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["/Users/albertyang0888/code/claude-deploy", "claude-deploy"],
    ["/Users/albertyang0888/code/claude-supervisor-2279d811", "claude-supervisor-2279d811"],
  ])("recognizes production tree %s independently", (cwd, graphName) => {
    const result = runHook("rg -n dispatcher .", {
      sessionId: "session-production-" + graphName,
      turnId: "turn-production-" + graphName,
      cwd,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("query the canonical shared graph first");
  });

  it("fails closed for a configured repository when the graph catalog is absent", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-no-catalog-"));
    const repo = join(fixture, "repo");
    const graphRoot = join(fixture, "missing-graphs");
    const repoMapFile = join(fixture, "repo-map.json");
    mkdirSync(repo);
    writeFileSync(repoMapFile, JSON.stringify({
      version: 1,
      repositories: [{ graph: "telecodex", path_prefixes: [repo] }],
    }));
    try {
      const result = runHook("rg -n createBot .", {
        sessionId: "session-no-catalog",
        turnId: "turn-no-catalog",
        cwd: repo,
        graphRoot,
        repoMapFile,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("query the canonical shared graph first");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not trust a predictable forged marker", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-forged-"));
    const sessionId = "session-forged";
    const turnId = "turn-forged";
    const digest = createHash("sha256").update(sessionId + ":" + turnId).digest("hex");
    writeFileSync(
      join(stateDir, digest + ".json"),
      JSON.stringify({ graph_name: "telecodex", created_at: Date.now() / 1000 }),
      { mode: 0o600 },
    );
    try {
      expect(runHook("rg -n createBot src", {
        sessionId,
        turnId,
        cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
        stateDir,
      }).status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not delete unrelated stale state files", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-cleanup-"));
    const unrelated = join(stateDir, "unrelated.txt");
    writeFileSync(unrelated, "keep");
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(unrelated, stale, stale);
    try {
      runHook(
        "~/.local/bin/graphify query typing --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        {
          sessionId: "session-cleanup",
          turnId: "turn-cleanup",
          cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
          stateDir,
        },
      );
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an insecure graphify state directory", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-insecure-"));
    chmodSync(stateDir, 0o755);
    try {
      expect(runHook(
        "~/.local/bin/graphify query typing --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        {
          sessionId: "session-insecure",
          turnId: "turn-insecure",
          cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
          stateDir,
        },
      ).status).not.toBe(0);
    } finally {
      chmodSync(stateDir, 0o700);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires affected before direct code edits", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-affected-edit-"));
    const common = {
      sessionId: "session-affected-edit",
      turnId: "turn-affected-edit",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify query typing --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(runHook("", {
        ...common,
        toolName: "apply_patch",
        toolInput: { file_path: "src/bot.ts", patch: "*** Begin Patch" },
      }).status).not.toBe(0);
      expect(executeGraphify(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(executeGraphify(
        "~/.local/bin/graphify affected createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(runHook("", {
        ...common,
        toolName: "apply_patch",
        toolInput: { file_path: "src/bot.ts", patch: "*** Begin Patch" },
      }).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires affected before shell-based code writes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-affected-shell-"));
    const common = {
      sessionId: "session-affected-shell",
      turnId: "turn-affected-shell",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };
    const writeCommand = "node -e \"require('node:fs').writeFileSync('src/bot.ts','x')\"";
    try {
      expect(executeGraphify(
        "~/.local/bin/graphify query typing --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(runHook(writeCommand, common).status).not.toBe(0);
      expect(executeGraphify(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(executeGraphify(
        "~/.local/bin/graphify affected createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        common,
      ).status).toBe(0);
      expect(runHook(writeCommand, common).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks direct edit tools before graphify", () => {
    const result = runHook("", {
      sessionId: "session-edit",
      turnId: "turn-edit",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      toolName: "apply_patch",
      toolInput: { patch: "*** Begin Patch\n*** Update File: src/bot.ts" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("query the canonical shared graph first");
  });

  it("allows graph questions containing shell-like words", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const options = {
      sessionId: "session-shell-words",
      turnId: "turn-shell-words",
      cwd: "/Users/albertyang0888/code/codex-telegram-research/telecodex",
      stateDir,
    };

    try {
      const graph = runHook(
        "~/.local/bin/graphify query 'find createBot caller' --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(graph.status).toBe(0);
      const rewritten = JSON.parse(graph.stdout).hookSpecificOutput.updatedInput.command;
      expect(
        spawnSync("/bin/zsh", ["-lc", rewritten], {
          cwd: options.cwd,
          env: {
            ...process.env,
            CODEX_GRAPHIFY_GATE_STATE_DIR: stateDir,
          },
          encoding: "utf8",
        }).status,
      ).toBe(0);
      const afterBroadQuery = runHook("rg -n createBot src", options);
      expect(afterBroadQuery.status).not.toBe(0);
      expect(afterBroadQuery.stderr).toContain("explain");
      expect(executeGraphify(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      ).status).toBe(0);
      expect(runHook("rg -n createBot src", options).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("records graphify only after the rewritten command succeeds", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const repoMapFile = join(stateDir, "repo-map.json");
    const cwd = "/Users/albertyang0888/.config/superpowers/worktrees/telecodex/alb-1363-graphify-gate";
    writeFileSync(
      repoMapFile,
      JSON.stringify({
        version: 1,
        repositories: [{ graph: "telecodex", path_prefixes: [cwd] }],
      }),
    );
    const options = {
      sessionId: "session-rewrite",
      turnId: "turn-rewrite",
      cwd,
      stateDir,
      repoMapFile,
    };

    try {
      const pre = runHook(
        "~/.local/bin/graphify explain createBot --graph ~/personas/_shared/graphify/graphs/telecodex/graph.json",
        options,
      );
      expect(pre.status).toBe(0);
      expect(pre.stdout).not.toBe("");
      const decision = JSON.parse(pre.stdout);
      expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
      const rewritten = decision.hookSpecificOutput.updatedInput.command as string;
      expect(rewritten).toContain("--run-graphify");

      const stillBlocked = runHook("rg -n createBot src", options);
      expect(stillBlocked.status).not.toBe(0);

      const executed = spawnSync("/bin/zsh", ["-lc", rewritten], {
        cwd,
        env: {
          ...process.env,
          CODEX_GRAPHIFY_GATE_STATE_DIR: stateDir,
          CODEX_GRAPHIFY_REPO_MAP_FILE: repoMapFile,
        },
        encoding: "utf8",
      });
      expect(executed.status).toBe(0);
      expect(executed.stdout).toContain("Node: createBot()");

      expect(runHook("rg -n createBot src", options).status).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not record graphify when the rewritten command fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-graphify-gate-test-"));
    const graphRoot = join(stateDir, "graphs");
    const graphDir = join(graphRoot, "telecodex");
    const fakeBin = join(stateDir, "graphify");
    const repoMapFile = join(stateDir, "repo-map.json");
    const cwd = "/Users/albertyang0888/.config/superpowers/worktrees/telecodex/alb-1363-graphify-gate";
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "graph.json"), "{}");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    writeFileSync(
      repoMapFile,
      JSON.stringify({
        version: 1,
        repositories: [{ graph: "telecodex", path_prefixes: [cwd] }],
      }),
    );
    const options = {
      sessionId: "session-failed-rewrite",
      turnId: "turn-failed-rewrite",
      cwd,
      stateDir,
      graphifyBin: fakeBin,
      graphRoot,
      repoMapFile,
    };

    try {
      const pre = runHook(
        fakeBin + " explain createBot --graph " + join(graphDir, "graph.json"),
        options,
      );
      expect(pre.status).toBe(0);
      const decision = JSON.parse(pre.stdout);
      const rewritten = decision.hookSpecificOutput.updatedInput.command as string;

      const executed = spawnSync("/bin/zsh", ["-lc", rewritten], {
        cwd,
        env: {
          ...process.env,
          CODEX_GRAPHIFY_BIN: fakeBin,
          CODEX_GRAPHIFY_GRAPH_ROOT: graphRoot,
          CODEX_GRAPHIFY_GATE_STATE_DIR: stateDir,
          CODEX_GRAPHIFY_REPO_MAP_FILE: repoMapFile,
        },
        encoding: "utf8",
      });
      expect(executed.status).toBe(7);
      expect(runHook("rg -n createBot src", options).status).not.toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows ordinary read-only shell commands", () => {
    const result = runHook("rg -n pkill src");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each([
    "killall -TERM node",
    "/usr/bin/pkill -f tsc",
    "echo ok && kill -9 1234",
    "launchctl bootout gui/501/com.example",
    "sudo rm -rf /tmp/example",
    "osascript -e 'tell application \"Terminal\" to quit'",
    "bash -lc 'killall -TERM node'",
    "/bin/zsh -c 'echo ok && pkill -f tsc'",
    "printf 'node\\n' | xargs pkill -f",
    "find . -name node -exec killall {} ;",
    "echo $(pkill -f tsc)",
    "echo ok\npkill -f tsc",
    "echo ok\r\nkillall node",
    "exec pkill -f tsc",
    "nohup killall node",
    "if pkill -f tsc; then echo stopped; fi",
    "echo `pkill -f tsc`",
    "echo `killall node`",
    "eval pkill -f tsc",
    "eval 'killall node'",
    "trap 'pkill -f tsc' EXIT",
    "{ pkill -f tsc; }",
    "f(){ pkill -f tsc; }; f",
    "f() { pkill -f tsc; }; f",
    "function f { pkill -f tsc; }; f",
    "bash -lc '{ pkill -f tsc; }'",
    "cmd=pkill; $cmd -f tsc",
    "cmd=pkill\n$cmd -f tsc",
    "CMD=killall; $CMD node",
    "$(printf pkill) -f tsc",
    "$(printf /usr/bin/pkill) -f tsc",
    "shopt -s expand_aliases\nalias k=pkill\nk -f tsc",
    "! pkill -f tsc",
    "bash -lc '! pkill -f tsc'",
    "zsh -c 'coproc pkill -f tsc'",
    "> /tmp/codex-hook-review.out pkill -f tsc",
    ">/tmp/codex-hook-review.out pkill -f tsc",
    "2>/tmp/codex-hook-review.err pkill -f tsc",
    "FOO=1 > /tmp/codex-hook-review.out pkill -f tsc",
    "bash -lc '> /tmp/codex-hook-review.out pkill -f tsc'",
    "echo \"$(pkill -f tsc)\"",
    "printf %s \"$(pkill -f tsc)\"",
    "x=\"$(pkill -f tsc)\"",
    "x=\"$(pkill -f tsc)\" echo ok",
    "bash -lc 'echo \"$(pkill -f tsc)\"'",
    "zsh -c 'x=\"$(pkill -f tsc)\"'",
    "command echo \"$(pkill -f tsc)\"",
    "echo ok > \"$(pkill -f tsc)\"",
    "hash -p /usr/bin/pkill k; k -f tsc",
    "bash -lc 'hash -p /usr/bin/pkill k; k -f tsc'",
    "command hash -p /usr/bin/pkill k; k -f tsc",
    "builtin hash -p /usr/bin/pkill k; k -f tsc",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; sh /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; zsh /tmp/codex-hook-review.sh",
    "bash -lc \"printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash /tmp/codex-hook-review.sh\"",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; source /tmp/codex-hook-review.sh",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; . /tmp/codex-hook-review.sh",
    "bash --norc -c 'pkill -f tsc'",
    "bash --rcfile /dev/null -c 'pkill -f tsc'",
    "bash --restricted -c 'pkill -f tsc'",
    "printf 'pkill -f tsc\\n' > /tmp/codex-hook-review.sh; bash --norc /tmp/codex-hook-review.sh",
    "zsh --no-rcs -c 'pkill -f tsc'",
    "env -S \"bash -c 'pkill -f tsc'\"",
    "env -S \"sh -c 'pkill -f tsc'\"",
    "env -S \"/usr/bin/pkill -f tsc\"",
    "env FOO=1 -S \"bash -c 'pkill -f tsc'\"",
    "env --split-string=\"bash -c 'pkill -f tsc'\"",
    "cmd=kill; p$cmd -f tsc",
    "cmd=ill; pk$cmd -f tsc",
    "cmd=kill; p${cmd} -f tsc",
    "p$'kill' -f tsc",
    "p$\"kill\" -f tsc",
    "bash -lc \"p$'kill' -f tsc\"",
    "env -u FOO pkill -f tsc",
    "env -u FOO /usr/bin/pkill -f tsc",
    "env -u FOO launchctl help",
    "env -C /tmp launchctl help",
    "env -P /bin launchctl help",
    "nice -n +5 launchctl help",
    "arch -arch arm64 launchctl help",
    "timeout -s TERM launchctl help",
    "/usr/bin/pki* -f tsc",
    "/bin/launchct* help",
    "cd /usr/bin; pki* -f tsc",
    "cd /bin; launchct* help",
    "bash -lc '/usr/bin/pki* -f tsc'",
    "p{k,}ill -f tsc",
    "/bin/launch{ctl,} help",
    "bash -lc 'p{k,}ill -f tsc'",
  ])("blocks host control command: %s", (command) => {
    const result = runHook(command);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Blocked Codex shell command");
  });

  it("allows safe shell wrapper commands", () => {
    const result = runHook("bash -lc 'rg -n pkill src'");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("allows the audited THEO self-restart helper but still blocks raw launchctl", () => {
    const helper = "/Users/albertyang0888/code/codex-telegram-research/discipline-workspace/bin/theo-self-restart";

    expect(runHook(`${helper} --dry-run`).status).toBe(0);
    expect(runHook(helper).status).toBe(0);

    const rawLaunchctl = runHook("launchctl kickstart -k gui/501/com.albert.albert-v3-codex-dispatcher");
    expect(rawLaunchctl.status).not.toBe(0);
    expect(rawLaunchctl.stderr).toContain("Blocked Codex shell command");
  });

  it("fails closed when the hook input is malformed", () => {
    const result = spawnSync("/usr/bin/python3", [hookScript], {
      input: "not-json",
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid Codex hook input");
  });
});
