import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ForegroundTextPromptStatus = "pending" | "processing";

export interface ForegroundTextPromptEntry {
  id: string;
  contextKey: string;
  chatId: number | string;
  fromId?: number;
  messageId?: number;
  messageThreadId?: number;
  text: string;
  status: ForegroundTextPromptStatus;
  attempts: number;
  claimProcessId?: number;
  claimToken?: string;
  createdAt: number;
  updatedAt: number;
}

interface ForegroundTextPromptState {
  version: 1;
  entries: Record<string, ForegroundTextPromptEntry>;
}

export interface EnqueueForegroundTextPromptInput {
  contextKey: string;
  chatId: number | string;
  fromId?: number;
  messageId?: number;
  messageThreadId?: number;
  text: string;
}

export interface EnqueueForegroundTextPromptResult {
  id: string;
  inserted: boolean;
  entry: ForegroundTextPromptEntry;
}

export interface ForegroundTextPromptClaim {
  id: string;
  claimToken: string;
}

const QUEUE_VERSION = 1;
const QUEUE_FILE = "foreground_text_prompts.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const PROCESSING_CLAIM_STALE_MS = 30_000;

export class ForegroundTextPromptQueue {
  private readonly queuePath: string;
  private readonly lockPath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(workspace: string) {
    this.queuePath = path.join(workspace, ".telecodex", QUEUE_FILE);
    this.lockPath = `${this.queuePath}.lock`;
  }

  get path(): string {
    return this.queuePath;
  }

  async enqueue(input: EnqueueForegroundTextPromptInput): Promise<EnqueueForegroundTextPromptResult> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("Cannot persist an empty foreground text prompt");
    }

    return await this.serialize(async () => {
      return await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        const now = Date.now();
        const id = foregroundTextPromptId(input.contextKey, input.messageId, now);
        const existing = state.entries[id];
        if (existing) {
          return { id, inserted: false, entry: existing };
        }

        const entry: ForegroundTextPromptEntry = {
          id,
          contextKey: input.contextKey,
          chatId: input.chatId,
          fromId: input.fromId,
          messageId: input.messageId,
          messageThreadId: input.messageThreadId,
          text,
          status: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };
        state.entries[id] = entry;
        await this.writeState(state, lockToken);
        return { id, inserted: true, entry };
      });
    });
  }

  async markProcessing(id: string): Promise<ForegroundTextPromptEntry | undefined> {
    const [entry] = await this.markProcessingMany([id]);
    return entry;
  }

  async claim(id: string): Promise<ForegroundTextPromptEntry | undefined> {
    const [entry] = await this.claimMany([id]);
    return entry;
  }

  async claimMany(ids: string[]): Promise<ForegroundTextPromptEntry[]> {
    return await this.serialize(async () => {
      return await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        const claimedEntries: ForegroundTextPromptEntry[] = [];
        const now = Date.now();
        const claimToken = `${process.pid}:${randomUUID()}`;
        for (const id of ids) {
          const entry = state.entries[id];
          if (!entry || !isForegroundTextPromptClaimable(entry, now)) {
            continue;
          }
          const claimed = {
            ...entry,
            status: "processing" as const,
            attempts: entry.attempts + 1,
            claimProcessId: process.pid,
            claimToken,
            updatedAt: now,
          };
          state.entries[id] = claimed;
          claimedEntries.push(claimed);
        }
        if (claimedEntries.length > 0) {
          await this.writeState(state, lockToken);
        }
        return claimedEntries;
      });
    });
  }

  async markProcessingMany(ids: string[]): Promise<ForegroundTextPromptEntry[]> {
    return await this.serialize(async () => {
      return await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        const updatedEntries: ForegroundTextPromptEntry[] = [];
        const now = Date.now();
        for (const id of ids) {
          const entry = state.entries[id];
          if (!entry) {
            continue;
          }
          const updated = {
            ...entry,
            status: "processing" as const,
            attempts: entry.attempts + 1,
            updatedAt: now,
          };
          state.entries[id] = updated;
          updatedEntries.push(updated);
        }
        if (updatedEntries.length > 0) {
          await this.writeState(state, lockToken);
        }
        return updatedEntries;
      });
    });
  }

  async markPending(id: string): Promise<void> {
    await this.markPendingMany([id]);
  }

  async markPendingMany(ids: string[]): Promise<void> {
    await this.serialize(async () => {
      await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        let changed = false;
        const now = Date.now();
        for (const id of ids) {
          const entry = state.entries[id];
          if (!entry) {
            continue;
          }
          state.entries[id] = {
            ...withoutClaim(entry),
            status: "pending",
            updatedAt: now,
          };
          changed = true;
        }
        if (changed) {
          await this.writeState(state, lockToken);
        }
      });
    });
  }

  async markPendingClaimedMany(claims: ForegroundTextPromptClaim[]): Promise<void> {
    await this.serialize(async () => {
      await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        let changed = false;
        const now = Date.now();
        for (const claim of claims) {
          const entry = state.entries[claim.id];
          if (!entry || !isClaimOwner(entry, claim)) {
            continue;
          }
          state.entries[claim.id] = {
            ...withoutClaim(entry),
            status: "pending",
            updatedAt: now,
          };
          changed = true;
        }
        if (changed) {
          await this.writeState(state, lockToken);
        }
      });
    });
  }

  async remove(id: string): Promise<void> {
    await this.removeMany([id]);
  }

  async removeMany(ids: string[]): Promise<void> {
    await this.serialize(async () => {
      await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        let changed = false;
        for (const id of ids) {
          if (!state.entries[id]) {
            continue;
          }
          delete state.entries[id];
          changed = true;
        }
        if (changed) {
          await this.writeState(state, lockToken);
        }
      });
    });
  }

  async removeClaimedMany(claims: ForegroundTextPromptClaim[]): Promise<void> {
    await this.serialize(async () => {
      await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        let changed = false;
        for (const claim of claims) {
          const entry = state.entries[claim.id];
          if (!entry || !isClaimOwner(entry, claim)) {
            continue;
          }
          delete state.entries[claim.id];
          changed = true;
        }
        if (changed) {
          await this.writeState(state, lockToken);
        }
      });
    });
  }

  async touchClaimedMany(claims: ForegroundTextPromptClaim[]): Promise<void> {
    await this.serialize(async () => {
      await this.withFileLock(async (lockToken) => {
        const state = await this.readState();
        let changed = false;
        const now = Date.now();
        for (const claim of claims) {
          const entry = state.entries[claim.id];
          if (!entry || !isClaimOwner(entry, claim)) {
            continue;
          }
          state.entries[claim.id] = {
            ...entry,
            updatedAt: now,
          };
          changed = true;
        }
        if (changed) {
          await this.writeState(state, lockToken);
        }
      });
    });
  }

  async list(): Promise<ForegroundTextPromptEntry[]> {
    return await this.serialize(async () => {
      const state = await this.readState();
      return Object.values(state.entries).sort((left, right) => {
        return compareForegroundTextPromptEntries(left, right);
      });
    });
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async withFileLock<T>(task: (lockToken: string) => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.queuePath), { recursive: true });
    const lockToken = `${process.pid}:${randomUUID()}`;
    await this.acquireLock(lockToken);
    try {
      return await task(lockToken);
    } finally {
      await this.releaseLock(lockToken);
    }
  }

  private async acquireLock(lockToken: string): Promise<void> {
    for (;;) {
      const candidatePath = `${this.lockPath}.${process.pid}.${randomUUID()}.candidate`;
      try {
        await writeFile(candidatePath, lockToken, { encoding: "utf8", flag: "wx" });
        await link(candidatePath, this.lockPath);
        return;
      } catch (error) {
        if (!isNodeError(error) || !isLockExistsError(error)) {
          throw error;
        }

        if (await this.removeStaleLock()) {
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      } finally {
        await rm(candidatePath, { force: true }).catch(() => {});
      }
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const lockStat = await stat(this.lockPath);
      if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) {
        return false;
      }
      await rm(this.lockPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return true;
      }
      if (isNodeError(error) && error.code === "ENOTEMPTY") {
        return false;
      }
      throw error;
    }
  }

  private async releaseLock(lockToken: string): Promise<void> {
    try {
      const owner = await readFile(this.lockPath, "utf8");
      if (owner !== lockToken) {
        return;
      }
      await rm(this.lockPath, { recursive: true, force: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async assertLockOwner(lockToken: string): Promise<void> {
    const owner = await readFile(this.lockPath, "utf8");
    if (owner !== lockToken) {
      throw new Error("Foreground text prompt queue lock ownership was lost");
    }
  }

  private async readState(): Promise<ForegroundTextPromptState> {
    try {
      const raw = await readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(raw) as ForegroundTextPromptState;
      if (parsed.version !== QUEUE_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
        return emptyState();
      }
      return {
        version: QUEUE_VERSION,
        entries: parsed.entries,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  private async writeState(state: ForegroundTextPromptState, lockToken?: string): Promise<void> {
    await mkdir(path.dirname(this.queuePath), { recursive: true });
    if (lockToken) {
      await this.assertLockOwner(lockToken);
    }
    const tempPath = `${this.queuePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (lockToken) {
      await this.assertLockOwner(lockToken);
    }
    await rename(tempPath, this.queuePath);
  }
}

function foregroundTextPromptId(contextKey: string, messageId: number | undefined, now: number): string {
  if (messageId !== undefined) {
    return `${contextKey}:${messageId}`;
  }
  return `${contextKey}:${now}`;
}

function emptyState(): ForegroundTextPromptState {
  return {
    version: QUEUE_VERSION,
    entries: {},
  };
}

function compareForegroundTextPromptEntries(
  left: ForegroundTextPromptEntry,
  right: ForegroundTextPromptEntry,
): number {
  const createdAt = left.createdAt - right.createdAt;
  if (createdAt !== 0) {
    return createdAt;
  }

  const contextKey = left.contextKey.localeCompare(right.contextKey);
  if (contextKey !== 0) {
    return contextKey;
  }

  if (left.messageId !== undefined && right.messageId !== undefined) {
    const messageId = left.messageId - right.messageId;
    if (messageId !== 0) {
      return messageId;
    }
  }

  return left.id.localeCompare(right.id, undefined, { numeric: true });
}

function isForegroundTextPromptClaimable(entry: ForegroundTextPromptEntry, now: number): boolean {
  if (entry.status === "pending") {
    return true;
  }

  if (entry.claimProcessId === undefined) {
    return now - entry.updatedAt >= PROCESSING_CLAIM_STALE_MS;
  }

  if (now - entry.updatedAt >= PROCESSING_CLAIM_STALE_MS) {
    return true;
  }

  if (entry.claimProcessId === process.pid) {
    return false;
  }

  return !isProcessAlive(entry.claimProcessId);
}

function isClaimOwner(entry: ForegroundTextPromptEntry, claim: ForegroundTextPromptClaim): boolean {
  return entry.status === "processing" && entry.claimToken === claim.claimToken;
}

function withoutClaim(entry: ForegroundTextPromptEntry): ForegroundTextPromptEntry {
  const { claimProcessId: _claimProcessId, claimToken: _claimToken, ...rest } = entry;
  return rest;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isLockExistsError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EPERM";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}
