import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wrapperPath = path.join(process.cwd(), "scripts", "codex-no-user-config-wrapper.sh");

describe("codex runtime wrapper", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-wrapper-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is executable so CODEX_PATH preflight accepts it", () => {
    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
  });

  it("rewrites the SDK experimental JSON flag to the official Codex JSON flag", () => {
    const capturePath = path.join(tempDir, "argv.txt");
    const fakeCodexPath = path.join(tempDir, "fake-codex.sh");
    writeFakeCodex(fakeCodexPath, capturePath);

    execFileSync(
      wrapperPath,
      ["exec", "--experimental-json", "--model", "gpt-5.5", "prompt with spaces"],
      {
        env: {
          ...process.env,
          CODEX_HOME: path.join(tempDir, "codex-home"),
          REAL_CODEX: fakeCodexPath,
        },
      },
    );

    expect(readFileSync(capturePath, "utf8").trim().split("\n")).toEqual([
      `CODEX_HOME=${path.join(tempDir, "codex-home")}`,
      "exec",
      "--dangerously-bypass-hook-trust",
      "--json",
      "--model",
      "gpt-5.5",
      "prompt with spaces",
    ]);
  });

  it("discovers codex from PATH when REAL_CODEX is not set", () => {
    const capturePath = path.join(tempDir, "argv.txt");
    const fakeCodexPath = path.join(tempDir, "codex");
    writeFakeCodex(fakeCodexPath, capturePath);

    execFileSync(wrapperPath, ["exec", "--json", "hello"], {
      env: {
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(readFileSync(capturePath, "utf8")).toContain("hello\n");
  });

  it("creates an ignored repo-local CODEX_HOME by default", () => {
    const capturePath = path.join(tempDir, "argv.txt");
    const fakeCodexPath = path.join(tempDir, "fake-codex.sh");
    writeFakeCodex(fakeCodexPath, capturePath);

    execFileSync(wrapperPath, ["exec", "--json", "hello"], {
      env: {
        ...process.env,
        CODEX_HOME: undefined,
        REAL_CODEX: fakeCodexPath,
      },
    });

    const firstLine = readFileSync(capturePath, "utf8").split("\n")[0];
    expect(firstLine).toBe(`CODEX_HOME=${path.join(process.cwd(), ".telecodex", "codex-runtime-home")}`);
    expect(statSync(path.join(process.cwd(), ".telecodex", "codex-runtime-home")).isDirectory()).toBe(true);
  });
});

function writeFakeCodex(fakeCodexPath: string, capturePath: string): void {
  writeFileSync(
    fakeCodexPath,
    [
      "#!/bin/sh",
      "set -eu",
      `printf "CODEX_HOME=%s\\n" "$CODEX_HOME" > ${JSON.stringify(capturePath)}`,
      `for arg in "$@"; do printf "%s\\n" "$arg" >> ${JSON.stringify(capturePath)}; done`,
    ].join("\n"),
  );
  chmodSync(fakeCodexPath, 0o755);
}
