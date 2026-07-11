import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const installerPath = fileURLToPath(
  new URL("../scripts/install-codex-graphify-bundle.py", import.meta.url),
);

function runInstaller(
  codexHome: string,
  workspace: string,
  role = "developer",
  env: Record<string, string> = {},
) {
  return spawnSync("/usr/bin/python3", [
    installerPath,
    "--codex-home",
    codexHome,
    "--workspace",
    workspace,
    "--role",
    role,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        result[relative(root, path)] = readFileSync(path, "utf8");
      }
    }
  };
  visit(root);
  return result;
}

describe("Codex graphify builder bundle installer", () => {
  it("installs the reviewed developer bundle into isolated targets", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-install-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");

    try {
      const result = runInstaller(codexHome, workspace);

      expect(result.status).toBe(0);
      expect(existsSync(join(codexHome, "skills/graphify/SKILL.md"))).toBe(true);
      expect(existsSync(join(codexHome, "skills/graphify/references/repo-map.json"))).toBe(true);
      expect(existsSync(join(codexHome, "hooks/graphify/codex-pre-tool-use-policy.py"))).toBe(true);
      expect(existsSync(join(codexHome, "hooks/graphify/codex-graphify-turn-context.py"))).toBe(true);
      expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
      expect(existsSync(join(workspace, ".codex/hooks.json"))).toBe(false);
      expect(existsSync(join(workspace, ".codex/graphify-install.json"))).toBe(true);

      const hooks = readFileSync(join(codexHome, "hooks.json"), "utf8");
      expect(hooks).toContain(join(codexHome, "hooks/graphify/codex-pre-tool-use-policy.py"));
      expect(hooks).toContain(join(codexHome, "hooks/graphify/codex-graphify-turn-context.py"));
      expect(hooks).toContain("UserPromptSubmit");
      expect(hooks).toContain("PreToolUse");
      expect(result.stdout).toContain("installed Codex Developer graphify bundle");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("is byte-idempotent on a second install", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-idempotent-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");

    try {
      expect(runInstaller(codexHome, workspace).status).toBe(0);
      const first = snapshot(fixture);
      expect(runInstaller(codexHome, workspace).status).toBe(0);
      expect(snapshot(fixture)).toEqual(first);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects non-developer roles", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-role-"));

    try {
      const result = runInstaller(
        join(fixture, "codex-home"),
        join(fixture, "workspace"),
        "personal-assistant",
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("developer role only");
      expect(readdirSync(fixture)).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects targets inside the canonical graph root", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-root-"));
    const graphRoot = join(fixture, "shared-graphs");
    const target = join(graphRoot, "must-not-write");

    try {
      const result = runInstaller(
        join(target, "codex-home"),
        join(target, "workspace"),
        "developer",
        { CODEX_GRAPHIFY_GRAPH_ROOT: graphRoot },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must not target the shared graph root");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("does not partially install over an unmanaged hooks file", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-graphify-collision-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");
    const hooksPath = join(codexHome, "hooks.json");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(hooksPath, "{\"hooks\":{\"Stop\":[]}}\n");

    try {
      const result = runInstaller(codexHome, workspace);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("already contains unmanaged hooks");
      expect(readFileSync(hooksPath, "utf8")).toBe("{\"hooks\":{\"Stop\":[]}}\n");
      expect(existsSync(join(codexHome, "skills/graphify/SKILL.md"))).toBe(false);
      expect(existsSync(join(codexHome, "hooks/graphify/codex-pre-tool-use-policy.py"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

});
