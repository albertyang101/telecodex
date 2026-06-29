/**
 * handoff-buffer — per-chat recent-conversation buffer + HANDOFF render (ALB-1011).
 *
 * When a Codex thread is rotated (see rotation-policy), the fresh thread starts
 * empty. To continue coherently we carry forward a compact HANDOFF preamble built
 * from the recent exchange. telecodex is the bridge and already sees every user
 * message and assistant final reply, so we keep a small in-memory ring buffer per
 * chat (lightly persisted by the wiring layer for restart durability) instead of
 * re-parsing Codex's rollout JSONL.
 *
 * Everything here is pure and trivially testable; the runtime wiring (append on
 * each turn, persist, inject on rotation) lives in bot.ts.
 */

export type HandoffRole = "user" | "assistant";

export interface HandoffEntry {
  role: HandoffRole;
  text: string;
}

/** Opens every rendered preamble; stable so the wiring/tests can detect it. */
export const HANDOFF_MARKER = "[THREAD ROTATION / 自动翻页续接]";

export const DEFAULT_MAX_HANDOFF_ENTRIES = 20;
export const DEFAULT_MAX_ENTRY_CHARS = 800;
export const DEFAULT_MAX_HANDOFF_CHARS = 6000;

const ELLIPSIS = "…";

function normalize(text: string): string {
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Append an entry, returning a new array trimmed to the most recent `maxEntries`.
 * Empty / whitespace-only entries are ignored. Pure: the input is never mutated.
 */
export function appendEntry(
  buffer: HandoffEntry[],
  entry: HandoffEntry,
  maxEntries: number = DEFAULT_MAX_HANDOFF_ENTRIES,
): HandoffEntry[] {
  const text = normalize(entry.text);
  if (!text) {
    return buffer.slice();
  }
  const next = [...buffer, { role: entry.role, text }];
  if (maxEntries > 0 && next.length > maxEntries) {
    return next.slice(next.length - maxEntries);
  }
  return next;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars > 0 && text.length > maxChars) {
    return text.slice(0, maxChars) + ELLIPSIS;
  }
  return text;
}

function roleLabel(role: HandoffRole): string {
  return role === "user" ? "用户" : "你";
}

export interface RenderHandoffOptions {
  maxEntryChars?: number;
  maxTotalChars?: number;
}

/**
 * Render a compact HANDOFF preamble from the recent exchange. Bounded twice over —
 * per entry and in total — so the preamble itself stays small and the new thread
 * starts light (the entire point of rotating). When over the total budget the
 * most recent entries are the ones kept.
 */
export function renderHandoff(entries: HandoffEntry[], opts: RenderHandoffOptions = {}): string {
  const maxEntryChars = opts.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_HANDOFF_CHARS;

  const header =
    `${HANDOFF_MARKER}\n` +
    "你正从一个接近上下文上限的旧 thread 自动翻到这个新 thread。新 thread 上下文已清空，" +
    "只有这段交接 + 用户接下来的消息。请无缝接着聊：别重新自我介绍、别把已经聊过的重新问一遍。\n";
  const footer = "\n--- 交接结束，请接着回应用户接下来的消息 ---";

  if (entries.length === 0) {
    return (
      header +
      "\n（没有可携带的近期对话——这是一次冷启动式翻页，按用户接下来的消息正常继续即可。）" +
      footer
    );
  }

  // Build newest-first within the budget, then flip back to chronological order so
  // the most recent exchange always survives the total cap. At least the newest
  // entry is always kept, even if it alone exceeds the budget.
  const budget = Math.max(0, maxTotalChars - header.length - footer.length);
  const linesReversed: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const line = `[${roleLabel(e.role)}] ${truncate(normalize(e.text), maxEntryChars)}`;
    if (used + line.length + 1 > budget && linesReversed.length > 0) {
      break;
    }
    linesReversed.push(line);
    used += line.length + 1;
  }
  const body = linesReversed.reverse().join("\n");
  return `${header}\n--- 旧 thread 最近对话 ---\n${body}${footer}`;
}
