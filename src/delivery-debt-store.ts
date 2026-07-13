import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DeliveryDebt {
  id: string;
  contextKey: string;
  chatId: number | string;
  messageThreadId?: number;
  pendingAnswerMsgId?: number;
  chunks: string[];
  attempts: number;
  createdAt: number;
}

type NewDeliveryDebt = Omit<DeliveryDebt, "id" | "attempts" | "createdAt">;

export class DeliveryDebtStore {
  private readonly file: string;
  private debts: DeliveryDebt[];

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "delivery-debts.json");
    this.debts = this.load();
  }

  enqueue(input: NewDeliveryDebt): DeliveryDebt {
    const chunks = input.chunks.map((chunk) => chunk.trim()).filter(Boolean);
    if (chunks.length === 0) {
      throw new Error("delivery debt requires at least one chunk");
    }
    const debt: DeliveryDebt = {
      ...input,
      chunks,
      id: randomUUID(),
      attempts: 0,
      createdAt: Date.now(),
    };
    const next = [...this.debts, debt];
    this.persist(next);
    this.debts = next;
    return debt;
  }

  list(contextKey?: string): DeliveryDebt[] {
    const debts = contextKey === undefined ? this.debts : this.debts.filter((debt) => debt.contextKey === contextKey);
    return debts.map((debt) => ({ ...debt, chunks: [...debt.chunks] }));
  }

  contextKeys(): string[] {
    return [...new Set(this.debts.map((debt) => debt.contextKey))];
  }

  update(id: string, chunks: string[], attempts: number): void {
    const normalizedChunks = chunks.map((chunk) => chunk.trim()).filter(Boolean);
    const next = this.debts.flatMap((debt) => {
      if (debt.id !== id) {
        return [debt];
      }
      if (normalizedChunks.length === 0) {
        return [];
      }
      return [
        {
          ...debt,
          chunks: normalizedChunks,
          attempts: Math.max(0, Math.trunc(attempts)),
        },
      ];
    });
    if (next.length === this.debts.length && !this.debts.some((debt) => debt.id === id)) {
      return;
    }
    this.persist(next);
    this.debts = next;
  }

  remove(id: string): void {
    const next = this.debts.filter((debt) => debt.id !== id);
    if (next.length === this.debts.length) {
      return;
    }
    this.persist(next);
    this.debts = next;
  }

  hasPendingAnswer(contextKey: string, msgId: number): boolean {
    return this.debts.some(
      (debt) => debt.contextKey === contextKey && debt.pendingAnswerMsgId === msgId,
    );
  }

  private load(): DeliveryDebt[] {
    if (!existsSync(this.file)) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      throw new Error("invalid delivery debt store: unreadable or malformed JSON");
    }
    if (!Array.isArray(parsed) || !parsed.every(isDeliveryDebt)) {
      throw new Error("invalid delivery debt store: unexpected record shape");
    }
    return parsed.map((debt) => ({ ...debt, chunks: [...debt.chunks] }));
  }

  private persist(next: DeliveryDebt[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function isDeliveryDebt(value: unknown): value is DeliveryDebt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const debt = value as Partial<DeliveryDebt>;
  return (
    typeof debt.id === "string" &&
    typeof debt.contextKey === "string" &&
    (typeof debt.chatId === "number" || typeof debt.chatId === "string") &&
    (debt.messageThreadId === undefined || typeof debt.messageThreadId === "number") &&
    (debt.pendingAnswerMsgId === undefined || typeof debt.pendingAnswerMsgId === "number") &&
    Array.isArray(debt.chunks) &&
    debt.chunks.length > 0 &&
    debt.chunks.every((chunk) => typeof chunk === "string" && chunk.trim().length > 0) &&
    typeof debt.attempts === "number" &&
    Number.isInteger(debt.attempts) &&
    debt.attempts >= 0 &&
    typeof debt.createdAt === "number" &&
    Number.isFinite(debt.createdAt)
  );
}
