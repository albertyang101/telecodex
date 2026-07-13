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
  /** Telegram message id that owns this turn, when available. */
  turnId?: number;
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
  const next = [...buffer, { ...entry, text }];
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

function normalizeMessage(value: HandoffUnanswered | HandoffPendingOutput): HandoffMessage {
  if (typeof value === "string") {
    return { text: normalize(value) };
  }
  return {
    ...(typeof value.messageId === "number" ? { messageId: value.messageId } : {}),
    text: normalize(value.text),
  };
}

function messageIdentity(message: HandoffMessage): string {
  return typeof message.messageId === "number" ? "message_id=" + message.messageId : "";
}

function normalizePendingOutput(value: HandoffPendingOutput): HandoffPendingOutput {
  return {
    ...(typeof value.messageId === "number" ? { messageId: value.messageId } : {}),
    ...(value.debtId ? { debtId: normalize(value.debtId) } : {}),
    ...(value.contentSha256 ? { contentSha256: normalize(value.contentSha256).toLowerCase() } : {}),
    text: normalize(value.text),
  };
}

export interface RenderHandoffOptions {
  maxEntryChars?: number;
  maxTotalChars?: number;
}

/** Why the thread is being rotated (ALB-1205). */
export type HandoffReason = "threshold" | "hard-cap" | "timeout-abort";

export interface HandoffMessage {
  /** Stable Telegram message id; distinguishes identical text messages. */
  messageId?: number;
  text: string;
}

export type HandoffUnanswered = string | HandoffMessage;
export interface HandoffPendingOutput extends HandoffMessage {
  /** Stable key into the durable delivery outbox. */
  debtId?: string;
  /** SHA-256 of UTF-8 JSON.stringify(chunks) in the durable outbox. */
  contentSha256?: string;
}

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
  /** Truly unanswered messages this fresh turn must answer, oldest first. */
  unanswered?: HandoffUnanswered[];
  /** Future prompts still owned by Dispatcher; current model must not answer them. */
  queuedMessages?: HandoffMessage[];
  /** Exact durable output still awaiting Telegram delivery, oldest first. */
  pendingOutputs?: HandoffPendingOutput[];
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

const RECOVERY_CONTRACT =
  "--- 恢复控制面（事实不复制，现场读取） ---\n" +
  "- 当前责任：未内联；先读 workspace CURRENT_HANDOFF.md 恢复镜像，再从 Linear（唯一真相）的 assignee、close criteria 与 latest checkpoint 核准。\n" +
  "- 当前优先级：未内联；从 Linear priority、status 与 latest owner instruction 核准。\n" +
  "- 当前未知：未内联；从 latest checkpoint 的 unknowns 核准；没证据的继续标未知。\n" +
  "- 不脑补、不把计划当完成；Linear 读不到就明确阻塞。";

/**
 * Render a compact HANDOFF preamble from the recent exchange. Bounded twice over —
 * per entry and in total — so the preamble itself stays small and the new thread
 * starts light (the entire point of rotating). When over the total budget the
 * most recent entries are the ones kept.
 *
 * With a structured `context` (ALB-1205) the preamble additionally carries, in
 * priority order: rotation reason → compact recovery pointer → true unanswered owner work
 * → pending-output preview → interrupted turn → future Dispatcher queue → durable debt
 * refs → recovery/Linear metadata → recent conversation. The total budget stays the
 * same; lower-priority metadata and recent conversation yield before owner work.
 * Without a context the output is byte-identical to before.
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
  const finalize = (text: string): string => {
    if (!Number.isFinite(maxTotalChars) || maxTotalChars <= 0) {
      return "";
    }
    if (text.length <= maxTotalChars) {
      return text;
    }
    const notice =
      "\n（交接正文已按硬预算截断；完整事实从 CURRENT_HANDOFF.md、Linear 与 Dispatcher durable state 恢复。）";
    const suffix = notice + footer;
    const prefixBudget = Math.max(0, maxTotalChars - suffix.length);
    if (prefixBudget === 0) {
      return text.slice(0, maxTotalChars);
    }
    const prefix = text.slice(0, prefixBudget).trimEnd();
    return (prefix + suffix).slice(0, maxTotalChars);
  };

  // Hard-cap survival order is intentional: true owner work first, then output
  // delivery truth and the interrupted turn. Control metadata and recent history
  // are recoverable from durable sources, so they yield first under pressure.
  const contextSections: string[] = [];
  if (context) {
    contextSections.push(reasonLine(context), RECOVERY_GUIDANCE);

    let priorityExhausted = false;
    const pendingOutputs = (context.pendingOutputs ?? [])
      .map(normalizePendingOutput)
      .filter((item) => item.text.length > 0);
    const interruptedText = normalize(context.interruptedTurn ?? "");
    const interruptedSection = interruptedText
      ? "--- 最后断点 ---\n这条消息上一回合没答完，请优先接着答：\n" +
        "[用户] " + truncate(interruptedText, maxEntryChars)
      : undefined;

    const unansweredMessages = (context.unanswered ?? [])
      .map(normalizeMessage)
      .filter((item) => item.text.length > 0);
    if (unansweredMessages.length > 0) {
      const fixedLength =
        header.length +
        footer.length +
        contextSections.join("\n").length;
      const unansweredBudget = Math.max(0, maxTotalChars - fixedLength - 2);
      const ownerLines: string[] = ["--- 未答消息（逐条补答） ---"];
      let used = ownerLines[0]!.length;
      let dropped = 0;
      for (let index = 0; index < unansweredMessages.length; index += 1) {
        const item = unansweredMessages[index]!;
        const identity = messageIdentity(item);
        const line =
          "- " + (identity ? "[" + identity + "] " : "") +
          "[用户] " + truncate(item.text, maxEntryChars);
        if (used + line.length + 1 > unansweredBudget) {
          if (ownerLines.length > 1) {
            dropped = unansweredMessages.length - index;
            break;
          }
          priorityExhausted = true;
        }
        ownerLines.push(line);
        used += line.length + 1;
      }
      if (dropped > 0) {
        priorityExhausted = true;
        ownerLines.push("（另有 " + dropped + " 条未答消息超预算未列出）");
      }
      contextSections.push(ownerLines.join("\n"));
    }

    if (!priorityExhausted && pendingOutputs.length > 0) {
      const fixedLength =
        header.length +
        footer.length +
        contextSections.join("\n").length;
      const pendingBudget = Math.max(0, maxTotalChars - fixedLength - 2);
      const pendingLines: string[] = [
        "--- 待送达回复预览（Dispatcher 自动续送） ---",
        "预览可能截断；精确源是 workspace/.telecodex/delivery-debts.json。不要重跑原任务，不要重复生成或手工补发，Dispatcher 会自动续送。",
      ];
      let used = pendingLines.join("\n").length;
      let dropped = 0;
      for (let index = 0; index < pendingOutputs.length; index += 1) {
        const item = pendingOutputs[index]!;
        const identity = messageIdentity(item);
        const line = "- " + (identity ? "[" + identity + "] " : "") + truncate(item.text, maxEntryChars);
        if (used + line.length + 1 > pendingBudget) {
          if (pendingLines.length > 2) {
            dropped = pendingOutputs.length - index;
            break;
          }
          priorityExhausted = true;
        }
        pendingLines.push(line);
        used += line.length + 1;
      }
      if (dropped > 0) {
        priorityExhausted = true;
        pendingLines.push("（另有 " + dropped + " 条待送达回复超预算未列出，仍由 Dispatcher 续送）");
      }
      contextSections.push(pendingLines.join("\n"));
    }

    if (!priorityExhausted && interruptedSection) {
      contextSections.push(interruptedSection);
      const used = header.length + footer.length + contextSections.join("\n").length;
      priorityExhausted = used > maxTotalChars;
    }

    const queuedMessages = (context.queuedMessages ?? [])
      .map(normalizeMessage)
      .filter((item) => item.text.length > 0);
    if (!priorityExhausted && queuedMessages.length > 0) {
      const fixedLength = header.length + footer.length + contextSections.join("\n").length;
      const queuedBudget = Math.max(0, maxTotalChars - fixedLength - 2);
      const queuedLines: string[] = [
        "--- 后续排队消息（Dispatcher 逐条执行） ---",
        "这些消息仍在 Dispatcher 队列里；当前回合勿答、勿复述。稍后每条会以自己的 message_id 单独进入 Codex。",
      ];
      let used = queuedLines.join("\n").length;
      let dropped = 0;
      for (let index = 0; index < queuedMessages.length; index += 1) {
        const item = queuedMessages[index]!;
        const identity = messageIdentity(item);
        const line = "- " + (identity ? "[" + identity + "] " : "") + truncate(item.text, maxEntryChars);
        if (used + line.length + 1 > queuedBudget) {
          if (queuedLines.length > 2) {
            dropped = queuedMessages.length - index;
            break;
          }
          priorityExhausted = true;
        }
        queuedLines.push(line);
        used += line.length + 1;
      }
      if (dropped > 0) {
        priorityExhausted = true;
        queuedLines.push("（另有 " + dropped + " 条排队消息超预算未列出；仍由 Dispatcher 逐条执行）");
      }
      contextSections.push(queuedLines.join("\n"));
    }

    if (!priorityExhausted && pendingOutputs.length > 0) {
      const durableRefs = pendingOutputs
        .filter((item) => item.debtId || item.contentSha256)
        .slice(0, 3)
        .map((item) =>
          [
            item.debtId ? "debt_id=" + item.debtId : "",
            item.contentSha256 ? "sha256=" + item.contentSha256 : "",
            messageIdentity(item),
          ].filter(Boolean).join(" "),
        );
      const omitted = Math.max(0, pendingOutputs.length - durableRefs.length);
      contextSections.push(
        [
          "--- Dispatcher 待送达账本（精确源） ---",
          "- store: workspace/.telecodex/delivery-debts.json",
          "- 完整正文与 chunk 边界只认该 durable outbox；HANDOFF 上方只是有界预览。",
          ...(durableRefs.length > 0 ? ["- refs: " + durableRefs.join(" | ")] : []),
          ...(omitted > 0 ? ["- 另有 " + omitted + " 条，以 store 为准。"] : []),
        ].join("\n"),
      );
    }

    if (!priorityExhausted) {
      contextSections.push(RECOVERY_CONTRACT);
    }

    const linearIssues = [...new Set((context.linearIssues ?? [])
      .map((issue) => normalize(issue).toUpperCase())
      .filter((issue) => /^ALB-\d+$/.test(issue)))]
      .slice(0, 20);
    if (!priorityExhausted && linearIssues.length > 0) {
      contextSections.push(
        "--- Linear 在途控制面 ---\n" +
        "- refs: " + linearIssues.join(", ") + "\n" +
        "- 必须逐张读取 issue/comments/status/close criteria，再沿真实断点续做。",
      );
    }
  }
  const contextBlock = contextSections.length > 0 ? `\n${contextSections.join("\n\n")}\n` : "";

  if (entries.length === 0) {
    if (contextBlock) {
      return finalize(header + contextBlock + footer);
    }
    return finalize(
      header +
      "\n（没有可携带的近期对话——这是一次冷启动式翻页，按用户接下来的消息正常继续即可。）" +
      footer,
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
    return finalize(header + contextBlock + footer);
  }
  const body = linesReversed.reverse().join("\n");
  return finalize(header + contextBlock + recentHeading + body + footer);
}
