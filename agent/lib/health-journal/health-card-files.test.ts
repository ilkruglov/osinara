/**
 * Card files of the health journal over an in-memory store.
 *
 * Constructs covered:
 * - A card is written under its content hash; cards of its kind older than the grace period go, a
 *   card of another kind and a card still on its way to send_widget stay.
 * - The replay scenario A → B → replay A: A is written again with its own bytes, B stays.
 * - An erase committed while the card was written removes the card and fails the call.
 * - `removeHealthCards` drops every card.
 */
import { describe, expect, it } from "vitest";

import {
  HEALTH_CARD_DIRECTORY,
  type HealthCardStore,
  publishHealthCard,
  removeHealthCards,
} from "./health-card-files.js";

function memoryStore(clock: { now: number }): HealthCardStore & {
  files: Map<string, { bytes: string; updatedAt: Date }>;
} {
  const files = new Map<string, { bytes: string; updatedAt: Date }>();
  const writes = new Set<string>();
  return {
    files,
    async list() {
      return [...files.entries()].map(([path, file]) => ({ path, updatedAt: file.updatedAt }));
    },
    async remove(path) {
      files.delete(path);
    },
    // Like the workspace: a repeated operation key is a replay and writes nothing.
    async write(path, bytes, operationKey) {
      if (writes.has(operationKey)) return;
      writes.add(operationKey);
      files.set(path, { bytes: bytes.toString("utf8"), updatedAt: new Date(clock.now) });
    },
  };
}

const steady = async () => 0;

describe("health card files", () => {
  it("keeps the newer card and its replay, and drops cards older than the grace period", async () => {
    const clock = { now: Date.parse("2026-11-11T10:00:00Z") };
    const store = memoryStore(clock);
    const a = await publishHealthCard(store, {
      erasesBefore: 0,
      erasesNow: steady,
      html: "<b>A</b>",
      kind: "day-progress",
      operationKey: "call-a",
    });
    const week = await publishHealthCard(store, {
      erasesBefore: 0,
      erasesNow: steady,
      html: "<b>W</b>",
      kind: "week",
      operationKey: "call-w",
    });
    clock.now += 60_000;
    const b = await publishHealthCard(store, {
      erasesBefore: 0,
      erasesNow: steady,
      html: "<b>B</b>",
      kind: "day-progress",
      operationKey: "call-b",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith(`${HEALTH_CARD_DIRECTORY}/day-progress-`)).toBe(true);
    // A minute apart, A may still be on its way to send_widget: both stay.
    expect([...store.files.keys()].sort()).toEqual([a, b, week].sort());
    // A replay of A writes A again and keeps B.
    store.files.delete(a);
    const replay = await publishHealthCard(store, {
      erasesBefore: 0,
      erasesNow: steady,
      html: "<b>A</b>",
      kind: "day-progress",
      operationKey: "call-a",
    });
    expect(replay).toBe(a);
    expect(store.files.get(a)?.bytes).toBe("<b>A</b>");
    expect(store.files.has(b)).toBe(true);
    // Eleven minutes later a new card drops the old ones of its kind, not of another kind.
    clock.now += 11 * 60_000;
    const c = await publishHealthCard(store, {
      erasesBefore: 0,
      erasesNow: steady,
      html: "<b>C</b>",
      kind: "day-progress",
      operationKey: "call-c",
    });
    expect([...store.files.keys()].sort()).toEqual([c, week].sort());
  });

  it("removes a card written across an erase and fails", async () => {
    const store = memoryStore({ now: 0 });
    await expect(
      publishHealthCard(store, {
        erasesBefore: 0,
        erasesNow: async () => 1,
        html: "<b>old numbers</b>",
        kind: "week",
        operationKey: "call",
      }),
    ).rejects.toMatchObject({ code: "AGENT_HEALTH_ERASED_MEANWHILE" });
    expect(store.files.size).toBe(0);
  });

  it("drops every card on erase", async () => {
    const store = memoryStore({ now: 0 });
    for (const kind of ["day-progress", "day-evening", "week"] as const)
      await publishHealthCard(store, {
        erasesBefore: 0,
        erasesNow: steady,
        html: kind,
        kind,
        operationKey: kind,
      });
    expect(await removeHealthCards(store, "erase")).toHaveLength(3);
    expect(store.files.size).toBe(0);
  });
});
