import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService, type CreateOptions } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  nextModel?: string;
  nextReasoningEffort?: string;
  launchProfileId?: string;
  updatedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly creatingSessions = new Map<TelegramContextKey, Promise<CodexSessionService>>();
  private readonly creationVersions = new Map<TelegramContextKey, number>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean; launchProfileId?: string },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }
    const creating = this.creatingSessions.get(contextKey);
    if (creating) {
      return creating;
    }

    const meta = this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta, options?.launchProfileId);
    const createOptions: CreateOptions = {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
    };
    if (meta?.nextModel) {
      createOptions.nextModel = meta.nextModel;
    }
    if (meta?.nextReasoningEffort) {
      createOptions.nextReasoningEffort = meta.nextReasoningEffort;
    }
    const createVersion = this.creationVersions.get(contextKey) ?? 0;
    const createPromise = CodexSessionService.create(this.config, createOptions)
      .then((createdSession) => {
        if ((this.creationVersions.get(contextKey) ?? 0) !== createVersion) {
          createdSession.dispose();
          throw new Error(`Session creation for ${contextKey} was invalidated`);
        }
        this.sessions.set(contextKey, createdSession);
        return createdSession;
      })
      .finally(() => {
        if (this.creatingSessions.get(contextKey) === createPromise) {
          this.creatingSessions.delete(contextKey);
        }
      });

    this.creatingSessions.set(contextKey, createPromise);
    return createPromise;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      nextModel: info.nextModel,
      nextReasoningEffort: info.nextReasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.creatingSessions.delete(contextKey);
    this.creationVersions.set(contextKey, (this.creationVersions.get(contextKey) ?? 0) + 1);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    for (const contextKey of this.creatingSessions.keys()) {
      this.creationVersions.set(contextKey, (this.creationVersions.get(contextKey) ?? 0) + 1);
    }
    this.sessions.clear();
    this.creatingSessions.clear();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
  requestedLaunchProfileId: string | undefined,
): string | undefined {
  if (requestedLaunchProfileId) {
    if (findLaunchProfile(config.launchProfiles, requestedLaunchProfileId)) {
      return requestedLaunchProfileId;
    }

    console.warn(
      `Unknown requested launch profile "${requestedLaunchProfileId}". Falling back to ${config.defaultLaunchProfileId}.`,
    );
    return undefined;
  }

  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
