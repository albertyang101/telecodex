import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DeliveryDebtStore } from "../src/delivery-debt-store.js";

describe("DeliveryDebtStore", () => {
  it("persists only the undelivered remainder across a fresh store instance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-delivery-debt-store-"));
    const first = new DeliveryDebtStore(root);
    const debt = first.enqueue({
      contextKey: "42",
      chatId: 42,
      pendingAnswerMsgId: 120201,
      chunks: ["第一段欠送", "第二段欠送"],
    });

    first.update(debt.id, ["第二段欠送"], 1);
    const reloaded = new DeliveryDebtStore(root);

    expect(reloaded.list("42")).toEqual([
      expect.objectContaining({
        id: debt.id,
        contextKey: "42",
        chatId: 42,
        pendingAnswerMsgId: 120201,
        chunks: ["第二段欠送"],
        attempts: 1,
      }),
    ]);
    expect(reloaded.hasPendingAnswer("42", 120201)).toBe(true);

    reloaded.remove(debt.id);
    expect(new DeliveryDebtStore(root).list()).toEqual([]);
  });

  it("keeps memory empty when enqueue persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-delivery-debt-enqueue-fail-"));
    const store = new DeliveryDebtStore(root);
    await mkdir(path.join(root, "delivery-debts.json.tmp"));

    expect(() =>
      store.enqueue({
        contextKey: "42",
        chatId: 42,
        chunks: ["不能只留在内存"],
      }),
    ).toThrow();
    expect(store.list()).toEqual([]);
  });

  it("publishes update and removal to memory only after persistence succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-delivery-debt-mutate-fail-"));
    const store = new DeliveryDebtStore(root);
    const debt = store.enqueue({
      contextKey: "42",
      chatId: 42,
      chunks: ["原始欠送"],
    });
    await mkdir(path.join(root, "delivery-debts.json.tmp"));

    expect(() => store.update(debt.id, ["错误的新状态"], 1)).toThrow();
    expect(store.list("42")[0]).toEqual(
      expect.objectContaining({ chunks: ["原始欠送"], attempts: 0 }),
    );

    expect(() => store.remove(debt.id)).toThrow();
    expect(store.list("42")).toHaveLength(1);
  });

  it("refuses startup without overwriting a malformed persisted debt file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telecodex-delivery-debt-corrupt-"));
    const file = path.join(root, "delivery-debts.json");
    await writeFile(file, "{broken", "utf8");

    expect(() => new DeliveryDebtStore(root)).toThrow("invalid delivery debt store");
    expect(await readFile(file, "utf8")).toBe("{broken");
  });
});
