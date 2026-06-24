import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

  it("passes SDK stdin through to the supervised Codex process", () => {
    const stdinPath = path.join(tempDir, "stdin.txt");
    const fakeCodexPath = path.join(tempDir, "stdin-codex.sh");
    writeStdinCapturingCodex(fakeCodexPath, stdinPath);

    execFileSync(wrapperPath, ["exec", "--json"], {
      input: "prompt from sdk stdin\n",
      env: {
        ...process.env,
        REAL_CODEX: fakeCodexPath,
      },
    });

    expect(readFileSync(stdinPath, "utf8")).toBe("prompt from sdk stdin\n");
  });

  it("terminates the Codex process group when the SDK aborts the wrapper", async () => {
    const childPidPath = path.join(tempDir, "child.pid");
    const grandchildPidPath = path.join(tempDir, "grandchild.pid");
    const fakeCodexPath = path.join(tempDir, "stubborn-codex.sh");
    writeStubbornCodex(fakeCodexPath, childPidPath, grandchildPidPath);

    const wrapper = spawn(wrapperPath, ["exec", "--json", "hello"], {
      env: {
        ...process.env,
        CODEX_WRAPPER_KILL_GRACE_SECONDS: "0.05",
        REAL_CODEX: fakeCodexPath,
      },
      stdio: "ignore",
    });
    const ownedPids: number[] = [];

    try {
      ownedPids.push(await waitForPidFile(childPidPath));
      ownedPids.push(await waitForPidFile(grandchildPidPath));
      expect(ownedPids[1]).not.toBe(ownedPids[0]);

      wrapper.kill("SIGTERM");
      await waitForExit(wrapper, 1_000);
      await waitForPidGone(ownedPids[0], 1_000);
      await waitForPidGone(ownedPids[1], 1_000);
    } finally {
      for (const pid of ownedPids) {
        killPid(pid);
      }
      if (wrapper.pid && wrapper.exitCode === null && wrapper.signalCode === null) {
        killPid(wrapper.pid);
      }
    }
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

function writeStubbornCodex(fakeCodexPath: string, childPidPath: string, grandchildPidPath: string): void {
  writeFileSync(
    fakeCodexPath,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `printf "%s\\n" "$$" > ${JSON.stringify(childPidPath)}`,
      "trap '' TERM",
      "trap '' INT",
      "trap '' HUP",
      `bash -c 'trap "" TERM INT HUP; printf "%s\\n" "$$" > "$1"; while true; do sleep 1; done' stubborn-grandchild ${JSON.stringify(grandchildPidPath)} &`,
      "while true; do sleep 1; done",
    ].join("\n"),
  );
  chmodSync(fakeCodexPath, 0o755);
}

function writeStdinCapturingCodex(fakeCodexPath: string, stdinPath: string): void {
  writeFileSync(
    fakeCodexPath,
    [
      "#!/bin/sh",
      "set -eu",
      `cat > ${JSON.stringify(stdinPath)}`,
    ].join("\n"),
  );
  chmodSync(fakeCodexPath, 0o755);
}

async function waitForPidFile(filePath: string): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(filePath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // Keep polling until the fake process writes the pid file.
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for pid file: ${filePath}`);
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`PID ${pid} is still alive`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for wrapper exit"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
