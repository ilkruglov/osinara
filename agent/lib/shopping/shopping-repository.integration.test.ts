/**
 * Shopping repository tests (PostgreSQL).
 *
 * Constructs covered:
 * - A member adds, lists, marks and removes lines of their own list; a stale version is refused.
 * - A replayed operation key returns the same line without adding a second one.
 * - Another member sees none of it; a family group chat and a revoked membership are refused.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { createMemoryFamilyFixture } from "../memory-repository.integration-fixtures.js";
import { shoppingRepository } from "./shopping-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function auth(family: Awaited<ReturnType<typeof createMemoryFamilyFixture>>, who: "owner" | "member", groupId: string | null = null): MemoryAuthorization {
  const person = who === "owner" ? family.owner : family.member;
  return {
    familyId: family.familyId, groupId, role: who, scopes: ["personal", "family"],
    telegramActorId: person.telegramUserId, telegramActorKind: "telegram_user", telegramUserId: person.telegramUserId, userId: person.userId,
  } as MemoryAuthorization;
}

describeWithDatabase("shoppingRepository", () => {
  afterAll(closeDatabase);

  it("keeps one person's lines with versions, replays and refuses the family group", async () => {
    const suffix = `shop-${Date.now()}`;
    const family = await createMemoryFamilyFixture(suffix);
    const owner = auth(family, "owner");

    const added = await shoppingRepository.execute(owner, { action: "add", title: "Молоко", quantity: "2 пакета" }, "op-1");
    expect(added).toMatchObject({ item: { listName: "покупки", quantity: "2 пакета", title: "Молоко", version: 1 }, replayed: false });
    const replay = await shoppingRepository.execute(owner, { action: "add", title: "Молоко", quantity: "2 пакета" }, "op-1");
    expect(replay).toMatchObject({ item: { id: (added as { item: { id: string } }).item.id }, replayed: true });
    await expect(shoppingRepository.execute(owner, { action: "add", title: "Хлеб" }, "op-1")).rejects.toMatchObject({ code: "AGENT_SHOPPING_ACCESS_DENIED" });
    await shoppingRepository.execute(owner, { action: "add", listName: "дача", title: "Саженцы" }, "op-2");

    const open = await shoppingRepository.execute(owner, { action: "list" }, "") as { hasMore: boolean; items: { id: string; title: string; version: number }[]; page: number };
    expect(open.items.map((i) => i.title)).toEqual(["Молоко", "Саженцы"]);
    expect(open).toMatchObject({ hasMore: false, page: 1 });
    expect((await shoppingRepository.execute(owner, { action: "list", page: 2 }, "") as { items: unknown[] }).items).toEqual([]);
    const dacha = await shoppingRepository.execute(owner, { action: "list", listName: "дача" }, "") as { items: { title: string }[] };
    expect(dacha.items.map((i) => i.title)).toEqual(["Саженцы"]);

    const milk = open.items[0]!;
    await expect(shoppingRepository.execute(owner, { action: "buy", id: milk.id, version: 9 }, "op-3")).rejects.toMatchObject({ code: "AGENT_SHOPPING_VERSION_STALE" });
    const bought = await shoppingRepository.execute(owner, { action: "buy", id: milk.id, version: 1 }, "op-4") as { item: { boughtAt: string | null; version: number } };
    expect(bought.item.boughtAt).not.toBeNull();
    expect(bought.item.version).toBe(2);
    await expect(shoppingRepository.execute(owner, { action: "buy", id: milk.id, version: 2 }, "op-5")).rejects.toMatchObject({ code: "AGENT_SHOPPING_ALREADY_BOUGHT" });
    const openAfter = await shoppingRepository.execute(owner, { action: "list" }, "") as { items: { title: string }[] };
    expect(openAfter.items.map((i) => i.title)).toEqual(["Саженцы"]);
    await shoppingRepository.execute(owner, { action: "remove", id: milk.id, version: 2 }, "op-6");
    const all = await shoppingRepository.execute(owner, { action: "list", view: "all" }, "") as { items: { title: string }[] };
    expect(all.items.map((i) => i.title)).toEqual(["Саженцы"]);

    // Another member sees none of it; the family group is refused; a revoked membership too.
    const member = await shoppingRepository.execute(auth(family, "member"), { action: "list", view: "all" }, "") as { items: unknown[] };
    expect(member.items).toEqual([]);
    await expect(shoppingRepository.execute(auth(family, "owner", "00000000-0000-0000-0000-000000000001"), { action: "list" }, "")).rejects.toMatchObject({ code: "AGENT_SHOPPING_ACCESS_DENIED" });
    await database().query("DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2", [family.familyId, family.member.userId]);
    await expect(shoppingRepository.execute(auth(family, "member"), { action: "list" }, "")).rejects.toMatchObject({ code: "AGENT_SHOPPING_ACCESS_DENIED" });
  });
});
