import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const installerPath = fileURLToPath(
  new URL("../scripts/install-codex-role-bundles.py", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../scripts/codex-bot-role-bundles.json", import.meta.url),
);

function runInstaller(role: string, codexHome: string, workspace: string) {
  return spawnSync("/usr/bin/python3", [
    installerPath,
    "--codex-home",
    codexHome,
    "--workspace",
    workspace,
    "--role",
    role,
  ], { encoding: "utf8" });
}

describe("Codex Bot builder role bundles", () => {
  it("declares graphify as a default only for Developer Bots", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.version).toBe(1);
    expect(manifest.roles.developer.default_bundles).toContain("graphify");
    expect(manifest.roles["albert-personal"].default_bundles).not.toContain("graphify");
    expect(manifest.roles["family-personal"].default_bundles).not.toContain("graphify");
  });

  it("installs the graphify bundle by default for the developer role", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-role-developer-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");
    try {
      const result = runInstaller("developer", codexHome, workspace);

      expect(result.status).toBe(0);
      expect(existsSync(join(codexHome, "skills/graphify/SKILL.md"))).toBe(true);
      expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
      const receipt = JSON.parse(
        readFileSync(join(workspace, ".codex/role-bundles.json"), "utf8"),
      );
      expect(receipt.role).toBe("developer");
      expect(receipt.installed_bundles).toEqual(["graphify"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(["albert-personal", "family-personal"])(
    "keeps graphify off for %s",
    (role) => {
      const fixture = mkdtempSync(join(tmpdir(), "codex-role-personal-"));
      const codexHome = join(fixture, "codex-home");
      const workspace = join(fixture, "workspace");
      try {
        const result = runInstaller(role, codexHome, workspace);

        expect(result.status).toBe(0);
        expect(existsSync(join(codexHome, "skills/graphify/SKILL.md"))).toBe(false);
        expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
        const receipt = JSON.parse(
          readFileSync(join(workspace, ".codex/role-bundles.json"), "utf8"),
        );
        expect(receipt.role).toBe(role);
        expect(receipt.installed_bundles).toEqual([]);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when the shared role manifest names an unsupported bundle", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-role-unknown-bundle-"));
    const copiedInstaller = join(fixture, "install-codex-role-bundles.py");
    const copiedManifest = join(fixture, "codex-bot-role-bundles.json");
    copyFileSync(installerPath, copiedInstaller);
    writeFileSync(copiedManifest, JSON.stringify({
      version: 1,
      roles: {
        developer: { default_bundles: ["graphfiy"] },
      },
    }));
    try {
      const result = spawnSync("/usr/bin/python3", [
        copiedInstaller,
        "--codex-home",
        join(fixture, "codex-home"),
        "--workspace",
        join(fixture, "workspace"),
        "--role",
        "developer",
      ], { encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported default bundle");
      expect(existsSync(join(fixture, "codex-home"))).toBe(false);
      expect(existsSync(join(fixture, "workspace"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("is byte-idempotent when the developer role is installed twice", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-role-idempotent-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");
    try {
      expect(runInstaller("developer", codexHome, workspace).status).toBe(0);
      const first = [
        readFileSync(join(codexHome, "hooks.json"), "utf8"),
        readFileSync(join(workspace, ".codex/graphify-install.json"), "utf8"),
        readFileSync(join(workspace, ".codex/role-bundles.json"), "utf8"),
      ];
      expect(runInstaller("developer", codexHome, workspace).status).toBe(0);
      const second = [
        readFileSync(join(codexHome, "hooks.json"), "utf8"),
        readFileSync(join(workspace, ".codex/graphify-install.json"), "utf8"),
        readFileSync(join(workspace, ".codex/role-bundles.json"), "utf8"),
      ];

      expect(second).toEqual(first);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects an unknown builder role without writing targets", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-role-invalid-"));
    const codexHome = join(fixture, "codex-home");
    const workspace = join(fixture, "workspace");
    try {
      const result = runInstaller("unknown", codexHome, workspace);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown Codex Bot role");
      expect(existsSync(codexHome)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
