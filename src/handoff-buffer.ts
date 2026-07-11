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
export const DEFAULT_MAX_ENTRY_CHARS = 1200; // 契约 §A.4 定数（ALB-1220, Cody 拍板 1200）
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

/** Why the thread is being rotated (ALB-1205). */
export type HandoffReason = "threshold" | "hard-cap" | "timeout-abort";

/**
 * Optional structured context rendered into the HANDOFF preamble (ALB-1205).
 * Everything here is caller-supplied plain data; rendering stays pure.
 */
export interface HandoffContext {
  reason: HandoffReason;
  /** Last known context fill ratio, rendered as a percentage when present. */
  ratio?: number;
  /** Stable Linear issue identifiers needed to restore the active control plane. */
  linearIssues?: string[];
  /** Verbatim queued-but-unanswered user messages, oldest first. */
  unanswered?: string[];
  /** Verbatim user text of the turn that was aborted mid-answer, if any. */
  interruptedTurn?: string;
}

function isHandoffContext(value: unknown): value is HandoffContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const reason = (value as { reason?: unknown }).reason;
  return reason === "threshold" || reason === "hard-cap" || reason === "timeout-abort";
}

function reasonLine(context: HandoffContext): string {
  const label =
    context.reason === "hard-cap"
      ? "上下文占用触及硬上限，强制翻页"
      : context.reason === "timeout-abort"
        ? "上一回合超时被中断，翻页续接"
        : "上下文占用达到常规阈值，自动翻页";
  const ratio =
    typeof context.ratio === "number" && Number.isFinite(context.ratio) && context.ratio > 0
      ? `（上下文占用约 ${Math.round(Math.min(context.ratio, 1) * 100)}%）`
      : "";
  return `【翻页原因】${label}${ratio}`;
}

const RECOVERY_GUIDANCE =
  "【恢复指引】新线程先按 workspace AGENTS.md 的恢复纪律，拉 Linear 控制面对齐在途单，再接着回应用户。";

/**
 * Render a compact HANDOFF preamble from the recent exchange. Bounded twice over —
 * per entry and in total — so the preamble itself stays small and the new thread
 * starts light (the entire point of rotating). When over the total budget the
 * most recent entries are the ones kept.
 *
 * With a structured `context` (ALB-1205) the preamble additionally carries, in
 * order: rotation reason → recovery pointer → unanswered messages → interrupted
 * turn → recent conversation. The total budget stays the same; the recent
 * conversation yields first, so unanswered messages and the interrupted turn get
 * priority survival. Without a context the output is byte-identical to before.
 */
export function renderHandoff(entries: HandoffEntry[], opts?: RenderHandoffOptions): string;
export function renderHandoff(
  entries: HandoffEntry[],
  context: HandoffContext | undefined,
  opts?: RenderHandoffOptions,
): string;
export function renderHandoff(
  entries: HandoffEntry[],
  contextOrOpts?: HandoffContext | RenderHandoffOptions,
  maybeOpts?: RenderHandoffOptions,
): string {
  const context = isHandoffContext(contextOrOpts) ? contextOrOpts : undefined;
  const opts: RenderHandoffOptions =
    (context ? maybeOpts : (contextOrOpts as RenderHandoffOptions | undefined)) ?? {};
  const maxEntryChars = opts.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_HANDOFF_CHARS;

  const header =
    `${HANDOFF_MARKER}\n` +
    "你正从一个接近上下文上限的旧 thread 自动翻到这个新 thread。新 thread 上下文已清空，" +
    "只有这段交接 + 用户接下来的消息。请无缝接着聊：别重新自我介绍、别把已经聊过的重新问一遍。\n" +
    // 契约 §A.1（canonical_handoff_crosssession_contract）：live envelope 永远压过交接叙述。
    "实时收到的用户消息永远压过本交接单的叙述；消息归属只认实时信封，绝不因交接内容把实时消息当成已答或不属于自己。\n";
  const footer = "\n--- 交接结束，请接着回应用户接下来的消息 ---";

  // Fixed context sections (reason / recovery / unanswered / interrupted) come
  // first and are protected; the recent-conversation window yields first.
  const contextSections: string[] = [];
  if (context) {
    contextSections.push(reasonLine(context), RECOVERY_GUIDANCE);

    const linearIssues = [...new Set((context.linearIssues ?? [])
      .map((issue) => normalize(issue).toUpperCase())
      .filter((issue) => /^ALB-\d+$/.test(issue)))]
      .slice(0, 20);
    if (linearIssues.length > 0) {
      contextSections.push(
        "--- Linear 在途控制面 ---\n" +
        "- refs: " + linearIssues.join(", ") + "\n" +
        "- 必须逐张读取 issue/comments/status/close criteria，再沿真实断点续做。",
      );
    }

    const interruptedText = normalize(context.interruptedTurn ?? "");
    const interruptedSection = interruptedText
      ? "--- 最后断点 ---\n这条消息上一回合没答完，请优先接着答：\n" +
        `[用户] ${truncate(interruptedText, maxEntryChars)}`
      : undefined;

    const unansweredTexts = (context.unanswered ?? [])
      .map((text) => normalize(text))
      .filter((text) => text.length > 0);
    if (unansweredTexts.length > 0) {
      // Unanswered messages count against the total budget: keep as many whole
      // (per-entry truncated) messages as fit after the other fixed sections.
      const fixedLength =
        header.length +
        footer.length +
        contextSections.join("\n").length +
        (interruptedSection ? interruptedSection.length + 2 : 0);
      const unansweredBudget = Math.max(0, maxTotalChars - fixedLength - 2);
      const lines: string[] = ["--- 未答消息（逐条补答） ---"];
      let used = lines[0]!.length;
      let dropped = 0;
      for (const text of unansweredTexts) {
        const line = `- [用户] ${truncate(text, maxEntryChars)}`;
        if (used + line.length + 1 > unansweredBudget && lines.length > 1) {
          dropped += 1;
          continue;
        }
        lines.push(line);
        used += line.length + 1;
      }
      if (dropped > 0) {
        lines.push(`（另有 ${dropped} 条未答消息超预算未列出）`);
      }
      contextSections.push(lines.join("\n"));
    }

    if (interruptedSection) {
      contextSections.push(interruptedSection);
    }
  }
  const contextBlock = contextSections.length > 0 ? `\n${contextSections.join("\n\n")}\n` : "";

  if (entries.length === 0) {
    if (contextBlock) {
      return header + contextBlock + footer;
    }
    return (
      header +
      "\n（没有可携带的近期对话——这是一次冷启动式翻页，按用户接下来的消息正常继续即可。）" +
      footer
    );
  }

  // Build newest-first within the budget, then flip back to chronological order so
  // the most recent exchange always survives the total cap. Without a context the
  // newest entry is always kept, even if it alone exceeds the budget; with a
  // context the protected sections win and the conversation may drop entirely.
  // 契约 §A.2：已答侧显式标注（待答侧由 未答消息 / 最后断点 段显式承担）。
  const recentHeading = "\n--- 旧 thread 最近对话（以下均已答过，勿重答） ---\n";
  const budget = Math.max(
    0,
    maxTotalChars - header.length - footer.length - contextBlock.length - (contextBlock ? recentHeading.length : 0),
  );
  const linesReversed: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const line = `[${roleLabel(e.role)}] ${truncate(normalize(e.text), maxEntryChars)}`;
    if (used + line.length + 1 > budget && (linesReversed.length > 0 || Boolean(context))) {
      break;
    }
    linesReversed.push(line);
    used += line.length + 1;
  }
  if (context && linesReversed.length === 0) {
    return header + contextBlock + footer;
  }
  const body = linesReversed.reverse().join("\n");
  return `${header}${contextBlock}${recentHeading}${body}${footer}`;
}
