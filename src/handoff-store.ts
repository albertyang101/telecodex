/**
 * handoff-store — durable persistence for per-chat rotation state (ALB-1011).
 *
 * The rolling handoff buffer lives in memory, but Codex dispatchers are restarted
 * frequently by launchd (KeepAlive). Without persistence a restart would empty the
 * buffer and the next rotation's HANDOFF would carry nothing. We persist a tiny
 * JSON per chat next to the existing `.telecodex/contexts.json`, written atomically.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type HandoffEntry } from "./handoff-buffer.js";
import { type ChatRotationState, emptyChatState } from "./thread-rotation.js";

/** Map a context key (e.g. "6872058088" or "mailbox:albert-v3") to a state file path. */
export function handoffStatePath(stateDir: string, contextKey: string): string {
  const safe = contextKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(stateDir, `handoff-${safe}.json`);
}

function isHandoffEntry(value: unknown): value is HandoffEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { role?: unknown; text?: unknown };
  return (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string";
}

/**
 * Load persisted rotation state for a chat. Returns an empty state on any missing
 * file, corrupt JSON, or malformed shape — persistence is best-effort and must
 * never throw into the turn path. Malformed buffer entries are dropped.
 */
export function loadChatState(stateDir: string, contextKey: string): ChatRotationState {
  const file = handoffStatePath(stateDir, contextKey);
  try {
    if (!existsSync(file)) {
      return emptyChatState();
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const obj = (raw ?? {}) as {
      buffer?: unknown;
      pendingRotation?: unknown;
      pendingMandatory?: unknown;
      interruptedTurn?: unknown;
      interruptedAttempts?: unknown;
      lastKnownRatio?: unknown;
    };
    const buffer = Array.isArray(obj.buffer) ? obj.buffer.filter(isHandoffEntry) : [];
    const state: ChatRotationState = { buffer, pendingRotation: Boolean(obj.pendingRotation) };
    // ALB-1205 fields are optional for backward compatibility: a pre-ALB-1205
    // JSON simply lacks them (= false / undefined), and malformed values are
    // dropped rather than trusted.
    if (obj.pendingMandatory === true) {
      state.pendingMandatory = true;
    }
    if (typeof obj.interruptedTurn === "string" && obj.interruptedTurn.trim()) {
      state.interruptedTurn = obj.interruptedTurn;
    }
    if (typeof obj.interruptedAttempts === "number" && Number.isInteger(obj.interruptedAttempts) && obj.interruptedAttempts > 0) {
      state.interruptedAttempts = obj.interruptedAttempts;
    }
    if (typeof obj.lastKnownRatio === "number" && Number.isFinite(obj.lastKnownRatio) && obj.lastKnownRatio > 0) {
      state.lastKnownRatio = obj.lastKnownRatio;
    }
    return state;
  } catch {
    return emptyChatState();
  }
}

/**
 * Persist rotation state for a chat, creating the directory if needed and writing
 * atomically (temp file + rename) so a crash mid-write can't corrupt the file.
 */
export function saveChatState(stateDir: string, contextKey: string, state: ChatRotationState): void {
  const file = handoffStatePath(stateDir, contextKey);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify({
    buffer: state.buffer,
    pendingRotation: state.pendingRotation,
    // ALB-1205 fields; JSON.stringify drops the undefined ones so a state that
    // never used them round-trips to the same shape it started with.
    pendingMandatory: state.pendingMandatory === true,
    interruptedTurn: state.interruptedTurn,
    interruptedAttempts: state.interruptedAttempts,
    lastKnownRatio: state.lastKnownRatio,
  });
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, file);
}

/** Clear persisted rotation state after an explicit user-selected thread boundary. */
export function clearChatState(stateDir: string, contextKey: string): void {
  const file = handoffStatePath(stateDir, contextKey);
  rmSync(file, { force: true });
  rmSync(file + ".tmp", { force: true });
}
