import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => ({
  staleLocksImmediately: false,
  staleLockChecksRemaining: 0,
  staleLockDirsWithoutOwner: false,
  blockFirstTempWrite: false,
  blockFirstOwnerWrite: false,
  tempWriteCount: 0,
  ownerWriteCount: 0,
  firstTempWriteStarted: undefined as undefined | (() => void),
  releaseFirstTempWrite: undefined as undefined | (() => void),
  firstOwnerWriteStarted: undefined as undefined | (() => void),
  releaseFirstOwnerWrite: undefined as undefined | (() => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
      const target = String(args[0]);
      if (
        (fsMockState.staleLocksImmediately || fsMockState.staleLockChecksRemaining > 0) &&
        target.endsWith("foreground_text_prompts.json.lock")
      ) {
        if (fsMockState.staleLockChecksRemaining > 0) {
          fsMockState.staleLockChecksRemaining -= 1;
        }
        return { mtimeMs: Date.now() - 31_000 } as Awaited<ReturnType<typeof actual.stat>>;
      }
      if (fsMockState.staleLockDirsWithoutOwner && target.endsWith("foreground_text_prompts.json.lock")) {
        const currentStat = await actual.stat(...args);
        if (currentStat.isDirectory()) {
          try {
            await actual.readFile(path.join(target, "owner"), "utf8");
          } catch {
            return { mtimeMs: Date.now() - 31_000 } as Awaited<ReturnType<typeof actual.stat>>;
          }
        }
        return currentStat;
      }
      return await actual.stat(...args);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const target = String(args[0]);
      if (
        fsMockState.blockFirstOwnerWrite &&
        (target.endsWith("foreground_text_prompts.json.lock/owner") ||
          /foreground_text_prompts\.json\.lock\..+\.candidate\/owner$/.test(target) ||
          /foreground_text_prompts\.json\.lock\..+\.candidate$/.test(target) ||
          target.endsWith("foreground_text_prompts.json.lock"))
      ) {
        fsMockState.ownerWriteCount += 1;
        if (fsMockState.ownerWriteCount === 1) {
          fsMockState.firstOwnerWriteStarted?.();
          await new Promise<void>((resolve) => {
            fsMockState.releaseFirstOwnerWrite = resolve;
          });
        }
      }
      if (fsMockState.blockFirstTempWrite && target.includes("foreground_text_prompts.json.") && target.endsWith(".tmp")) {
        fsMockState.tempWriteCount += 1;
        if (fsMockState.tempWriteCount === 1) {
          fsMockState.firstTempWriteStarted?.();
          await new Promise<void>((resolve) => {
            fsMockState.releaseFirstTempWrite = resolve;
          });
        }
      }
      return await actual.writeFile(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await actual.rename(...args);
    }),
  };
});

import { ForegroundTextPromptQueue } from "../src/foreground-prompt-queue.js";

describe("ForegroundTextPromptQueue", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    fsMockState.staleLocksImmediately = false;
    fsMockState.staleLockChecksRemaining = 0;
    fsMockState.staleLockDirsWithoutOwner = false;
    fsMockState.blockFirstTempWrite = false;
    fsMockState.blockFirstOwnerWrite = false;
    fsMockState.tempWriteCount = 0;
    fsMockState.ownerWriteCount = 0;
    fsMockState.firstTempWriteStarted = undefined;
    fsMockState.releaseFirstTempWrite = undefined;
    fsMockState.firstOwnerWriteStarted = undefined;
    fsMockState.releaseFirstOwnerWrite = undefined;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("serializes writes across queue instances so concurrent foreground receipts are not lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-lock-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const first = new ForegroundTextPromptQueue(workspace);
    const second = new ForegroundTextPromptQueue(workspace);

    await Promise.all([
      first.enqueue({
        contextKey: "42",
        chatId: 42,
        fromId: 123,
        messageId: 501,
        text: "first concurrent receipt",
      }),
      second.enqueue({
        contextKey: "42",
        chatId: 42,
        fromId: 123,
        messageId: 502,
        text: "second concurrent receipt",
      }),
    ]);

    const queue = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(Object.keys(queue.entries).sort()).toEqual(["42:501", "42:502"]);
  });

  it("orders same-millisecond Telegram receipts by numeric message id, not lexicographic id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-order-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:100": {
              id: "42:100",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 100,
              text: "second",
              status: "pending",
              attempts: 0,
              createdAt: 7,
              updatedAt: 7,
            },
            "42:99": {
              id: "42:99",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 99,
              text: "first",
              status: "pending",
              attempts: 0,
              createdAt: 7,
              updatedAt: 7,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const queue = new ForegroundTextPromptQueue(workspace);
    const entries = await queue.list();

    expect(entries.map((entry) => entry.messageId)).toEqual([99, 100]);
  });

  it("atomically claims a pending foreground receipt once across queue instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-claim-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:701": {
              id: "42:701",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 701,
              text: "claim me once",
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const first = new ForegroundTextPromptQueue(workspace);
    const second = new ForegroundTextPromptQueue(workspace);

    const claimed = await Promise.all([first.claim("42:701"), second.claim("42:701")]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
    const persisted = JSON.parse(
      await readFile(path.join(queueDir, "foreground_text_prompts.json"), "utf8"),
    );
    expect(persisted.entries["42:701"]).toMatchObject({
      status: "processing",
      attempts: 1,
      claimProcessId: process.pid,
    });
  });

  it("does not claim a fresh processing receipt owned by this process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-fresh-processing-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:702": {
              id: "42:702",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 702,
              text: "already processing",
              status: "processing",
              attempts: 1,
              claimProcessId: process.pid,
              claimToken: `${process.pid}:existing`,
              createdAt: 1,
              updatedAt: Date.now(),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const queue = new ForegroundTextPromptQueue(workspace);

    await expect(queue.claim("42:702")).resolves.toBeUndefined();
  });

  it("reclaims old processing receipts that predate claim ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-stale-processing-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:703": {
              id: "42:703",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 703,
              text: "stale processing from old build",
              status: "processing",
              attempts: 1,
              createdAt: 1,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const queue = new ForegroundTextPromptQueue(workspace);
    const claimed = await queue.claim("42:703");

    expect(claimed).toMatchObject({
      id: "42:703",
      status: "processing",
      attempts: 2,
      claimProcessId: process.pid,
    });
  });

  it("reclaims stale processing receipts even when a foreign claim pid is alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-stale-live-pid-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:704": {
              id: "42:704",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 704,
              text: "stale processing from a reused pid",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "1:old",
              createdAt: 1,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const queue = new ForegroundTextPromptQueue(workspace);
    const claimed = await queue.claim("42:704");

    expect(claimed).toMatchObject({
      id: "42:704",
      status: "processing",
      attempts: 2,
      claimProcessId: process.pid,
    });
  });

  it("reclaims stale processing receipts even when the old claim pid matches this process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-stale-same-pid-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:707": {
              id: "42:707",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 707,
              text: "stale processing from reused same pid",
              status: "processing",
              attempts: 1,
              claimProcessId: process.pid,
              claimToken: `${process.pid}:old`,
              createdAt: 1,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const queue = new ForegroundTextPromptQueue(workspace);
    const claimed = await queue.claim("42:707");

    expect(claimed).toMatchObject({
      id: "42:707",
      status: "processing",
      attempts: 2,
      claimProcessId: process.pid,
    });
  });

  it("does not let an old claim token remove a receipt after another owner reclaimed it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-token-remove-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:705": {
              id: "42:705",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 705,
              text: "new owner must survive old owner cleanup",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "old-token",
              createdAt: 1,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const queue = new ForegroundTextPromptQueue(workspace);
    const reclaimed = await queue.claim("42:705");
    expect(reclaimed?.claimToken).toBeTruthy();

    await queue.removeClaimedMany([{ id: "42:705", claimToken: "old-token" }]);

    const persisted = JSON.parse(
      await readFile(path.join(queueDir, "foreground_text_prompts.json"), "utf8"),
    );
    expect(persisted.entries["42:705"]).toMatchObject({
      text: "new owner must survive old owner cleanup",
      claimToken: reclaimed?.claimToken,
    });
  });

  it("heartbeats a foreign active claim so it does not become reclaimable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-heartbeat-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(workspace, ".telecodex");
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      path.join(queueDir, "foreground_text_prompts.json"),
      JSON.stringify(
        {
          version: 1,
          entries: {
            "42:706": {
              id: "42:706",
              contextKey: "42",
              chatId: 42,
              fromId: 123,
              messageId: 706,
              text: "active owner heartbeats",
              status: "processing",
              attempts: 1,
              claimProcessId: 1,
              claimToken: "active-token",
              createdAt: 1,
              updatedAt: Date.now() - 31_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const queue = new ForegroundTextPromptQueue(workspace);

    await queue.touchClaimedMany([{ id: "42:706", claimToken: "active-token" }]);

    await expect(queue.claim("42:706")).resolves.toBeUndefined();
  });

  it("does not let a stale writer overwrite a newer lock owner after recovery takeover", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-stale-owner-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const first = new ForegroundTextPromptQueue(workspace);
    const second = new ForegroundTextPromptQueue(workspace);
    const firstWriteStarted = new Promise<void>((resolve) => {
      fsMockState.firstTempWriteStarted = resolve;
    });
    fsMockState.blockFirstTempWrite = true;
    fsMockState.staleLockChecksRemaining = 1;

    const firstResult = first.enqueue({
      contextKey: "42",
      chatId: 42,
      fromId: 123,
      messageId: 601,
      text: "old stale writer",
    });
    await firstWriteStarted;

    await second.enqueue({
      contextKey: "42",
      chatId: 42,
      fromId: 123,
      messageId: 602,
      text: "new lock owner",
    });
    const queueAfterSecond = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(queueAfterSecond.entries["42:602"]).toMatchObject({ text: "new lock owner" });

    fsMockState.releaseFirstTempWrite?.();
    await firstResult.catch(() => undefined);

    const queue = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(queue.entries["42:602"]).toMatchObject({ text: "new lock owner" });
  });

  it("does not publish the lock path before the owner token is ready", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-foreground-queue-owner-gap-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const queue = new ForegroundTextPromptQueue(workspace);
    const firstOwnerWriteStarted = new Promise<void>((resolve) => {
      fsMockState.firstOwnerWriteStarted = resolve;
    });
    fsMockState.blockFirstOwnerWrite = true;

    const result = queue.enqueue({
      contextKey: "42",
      chatId: 42,
      fromId: 123,
      messageId: 611,
      text: "owner gap probe",
    });
    await firstOwnerWriteStarted;

    await expect(
      stat(path.join(workspace, ".telecodex", "foreground_text_prompts.json.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    fsMockState.releaseFirstOwnerWrite?.();
    await result;

    const persisted = JSON.parse(
      await readFile(path.join(workspace, ".telecodex", "foreground_text_prompts.json"), "utf8"),
    );
    expect(persisted.entries["42:611"]).toMatchObject({ text: "owner gap probe" });
  });
});
