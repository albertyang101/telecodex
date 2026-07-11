import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(
  new URL("../scripts/codex-graphify-skill/SKILL.md", import.meta.url),
);
const repoMapPath = fileURLToPath(
  new URL("../scripts/codex-graphify-skill/references/repo-map.json", import.meta.url),
);
const hookConfigPath = fileURLToPath(
  new URL("../scripts/codex-graphify-hooks.toml", import.meta.url),
);

describe("Albert graphify Codex overlay", () => {
  it("routes code questions to canonical shared graphs with the full binary path", () => {
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("/Users/albertyang0888/.local/bin/graphify");
    expect(skill).toContain("/Users/albertyang0888/personas/_shared/graphify/graphs/<graph-name>/graph.json");
    expect(skill).toContain("--graph");
    expect(skill).toContain("query");
    expect(skill).toContain("explain");
    expect(skill).toContain("affected");
  });

  it("forbids private graph creation and keeps Graphiti Memory out of scope", () => {
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("Never build, update, watch, install, or write a graph");
    expect(skill).toContain("Never use repo-local graphify-out");
    expect(skill).toContain("Graphiti");
    expect(skill).toContain("Personal Memory");
    expect(skill).not.toContain("falkordb");
    expect(skill).not.toContain("neo4j");
  });

  it("ships an explicit repository map and hooks for shell plus edit tools", () => {
    const repoMap = JSON.parse(readFileSync(repoMapPath, "utf8"));
    const config = readFileSync(hookConfigPath, "utf8");

    expect(repoMap.version).toBe(1);
    expect(repoMap.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ graph: "telecodex" }),
        expect.objectContaining({ graph: "claude-canonical" }),
      ]),
    );
    expect(config).toContain('matcher = "^Bash$"');
    expect(config).toContain('matcher = "^(apply_patch|Edit|Write)$"');
    expect(config).toContain('matcher = "^mcp__filesystem__.*$"');
    expect(config).toContain("[[hooks.UserPromptSubmit]]");
  });
});
