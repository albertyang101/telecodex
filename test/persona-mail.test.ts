import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendPersonaMail } from "../src/persona-mail.js";

describe("persona mailbox sender", () => {
  let tempDir: string;
  let personasRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-persona-mail-"));
    personasRoot = path.join(tempDir, "personas");
    mkdirSync(path.join(personasRoot, "albert-v4"), { recursive: true });
    mkdirSync(path.join(personasRoot, "albert-codex-e2e"), { recursive: true });
    writeFileSync(path.join(personasRoot, "albert-v4", "CLAUDE.md"), "# albert-v4 的 Agent — Vera\n", { flag: "wx" });
    writeFileSync(path.join(personasRoot, "albert-codex-e2e", "CLAUDE.md"), "# Ada\n", { flag: "wx" });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a display-name recipient to the real persona slug and writes one inbox message", async () => {
    const result = await sendPersonaMail(
      {
        to: "vera",
        subject: "[P1] Codex bot builder coordination",
        body: "Future Codex bots must use the shared TeleCodex thin bridge.",
        priority: "P1",
      },
      {
        personasRoot,
        sender: "albert-codex-e2e",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      from: "albert-codex-e2e",
      to: "albert-v4",
      resolved_alias: "vera",
      priority: "P1",
    });

    const inboxDir = path.join(personasRoot, "_shared", "memory", "mailbox", "albert-v4", "inbox");
    const files = readdirSync(inboxDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^albert-codex-e2e-/);
    const message = readFileSync(path.join(inboxDir, files[0]), "utf8");
    expect(message).toContain("from: albert-codex-e2e");
    expect(message).toContain("to: albert-v4");
    expect(message).toContain("subject: [P1] Codex bot builder coordination");
    expect(message).toContain("priority: P1");
    expect(message).toContain("Future Codex bots must use the shared TeleCodex thin bridge.");
  });

  it("rejects unknown recipients instead of creating a dead-letter inbox", async () => {
    const result = await sendPersonaMail(
      {
        to: "nobody-zzz",
        subject: "Should reject",
        body: "This must not create mailbox/nobody-zzz.",
      },
      {
        personasRoot,
        sender: "albert-codex-e2e",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      boundary: "unknown_recipient",
    });
    expect(() => readdirSync(path.join(personasRoot, "_shared", "memory", "mailbox", "nobody-zzz"))).toThrow();
  });
});
