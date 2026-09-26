/**
 * Personal shopping list: one person's lines, kept and read in their private chat.
 *
 * Exports:
 * - `shoppingInput`: the validated tool input.
 * - `shoppingRepository`: add, list, mark bought, unmark, remove.
 *
 * Key constructs:
 * - The list belongs to the person (`owner_user_id`), never to the family group: the owner
 *   decided the family sees no lists (26 сентября 2026). Every action checks the live membership
 *   and refuses anyone but a family member in their own private chat.
 * - A bought mark is a moment; the person is the buyer. Same titles are not merged.
 * - `version` guards concurrent edits: a stale version means "read the list again", never a guess.
 * - The Eve call id is the operation key: a replayed step returns the same line, adds nothing.
 * - Ported from artkruglov/homka (Apache-2.0) and reduced from shared spaces to a personal list.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";

export const DEFAULT_SHOPPING_LIST = "покупки";

export const shoppingInput = z.object({
  action: z.enum(["add", "list", "buy", "unbuy", "remove"]),
  id: z.uuid().optional(),
  listName: z.string().trim().min(1).max(100).optional(),
  page: z.number().int().min(1).max(1_000).optional(),
  note: z.string().trim().min(1).max(500).nullable().optional(),
  quantity: z.string().trim().min(1).max(50).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  version: z.number().int().positive().optional(),
  view: z.enum(["open", "bought", "all"]).optional(),
}).strict().superRefine((value, ctx) => {
  const fields: Record<string, string[]> = {
    add: ["listName", "title", "quantity", "note"],
    buy: ["id", "version"], list: ["listName", "view", "page"],
    remove: ["id", "version"], unbuy: ["id", "version"],
  };
  for (const key of Object.keys(value)) {
    if (key !== "action" && !fields[value.action]!.includes(key)) {
      ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
    }
  }
  if (value.action === "add" && !value.title) ctx.addIssue({ code: "custom", message: "Для add нужен title" });
  if (["buy", "unbuy", "remove"].includes(value.action) && (!value.id || !value.version)) {
    ctx.addIssue({ code: "custom", message: "Нужны id и актуальная version из list" });
  }
});

export type ShoppingInput = z.infer<typeof shoppingInput>;

export interface ShoppingRow {
  bought_at: Date | null;
  id: string;
  list_name: string;
  note: string | null;
  quantity: string | null;
  title: string;
  version: number;
}

export interface ShoppingItem {
  boughtAt: string | null;
  id: string;
  listName: string;
  note: string | null;
  quantity: string | null;
  title: string;
  version: number;
}

export function presentShoppingItem(row: ShoppingRow): ShoppingItem {
  return {
    boughtAt: row.bought_at === null ? null : row.bought_at.toISOString(),
    id: row.id, listName: row.list_name, note: row.note, quantity: row.quantity, title: row.title, version: row.version,
  };
}

function shoppingDenied(): never {
  throw new AppError("AGENT_SHOPPING_ACCESS_DENIED", "Список покупок ведётся только в личном чате члена семьи");
}

/** A family member in their own private chat, checked live: a revoked membership loses the list. */
async function authorizeShopping(client: PoolClient, auth: MemoryAuthorization): Promise<string> {
  if (auth.telegramActorKind !== "telegram_user" || !auth.telegramUserId || !auth.userId ||
    auth.telegramActorId !== auth.telegramUserId || auth.role === "external" || auth.groupId !== null) shoppingDenied();
  const member = await client.query(
    `SELECT 1 FROM family_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.family_id = $1 AND m.user_id = $2 AND u.telegram_user_id = $3`,
    [auth.familyId, auth.userId, auth.telegramUserId],
  );
  if (!member.rowCount) shoppingDenied();
  return auth.userId!;
}

const COLUMNS = "id, list_name, title, quantity, note, version, bought_at";
export const SHOPPING_PAGE_SIZE = 100;

/** One page plus one row: the extra row says whether a next page exists. */
async function selectItems(client: PoolClient, ownerUserId: string, input: ShoppingInput, id: string | null): Promise<{ hasMore: boolean; rows: ShoppingRow[] }> {
  const view = input.view ?? "open";
  const page = input.page ?? 1;
  const result = await client.query<ShoppingRow>(
    `SELECT ${COLUMNS} FROM shopping_items
      WHERE owner_user_id = $1 AND removed_at IS NULL
        AND ($2::uuid IS NULL OR id = $2::uuid)
        AND ($3::text IS NULL OR list_name = $3)
        AND ($4::text = 'all' OR ($4::text = 'bought') = (bought_at IS NOT NULL))
      ORDER BY bought_at NULLS FIRST, created_at, id LIMIT $5 OFFSET $6`,
    [ownerUserId, id, input.listName ?? null, view, SHOPPING_PAGE_SIZE + 1, (page - 1) * SHOPPING_PAGE_SIZE],
  );
  return { hasMore: result.rows.length > SHOPPING_PAGE_SIZE, rows: result.rows.slice(0, SHOPPING_PAGE_SIZE) };
}

export const shoppingRepository = {
  async execute(auth: MemoryAuthorization, raw: ShoppingInput, operationKey: string) {
    const parsed = shoppingInput.safeParse(raw);
    if (!parsed.success) throw new AppError("AGENT_SHOPPING_INPUT_INVALID", "Проверьте действие и поля пункта списка");
    const input = parsed.data;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const ownerUserId = await authorizeShopping(client, auth);
      if (input.action === "list") {
        const { hasMore, rows } = await selectItems(client, ownerUserId, input, null);
        await client.query("COMMIT");
        return { hasMore, items: rows.map(presentShoppingItem), page: input.page ?? 1 };
      }
      if (!operationKey || operationKey.length > 500) shoppingDenied();
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ownerUserId}:shopping:${operationKey}`]);
      const previous = await client.query<{ item_id: string; request_hash: string }>(
        "SELECT item_id, request_hash FROM shopping_item_operations WHERE owner_user_id = $1 AND operation_key = $2",
        [ownerUserId, operationKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) shoppingDenied();
        const [row] = (await selectItems(client, ownerUserId, { action: "list", view: "all" }, previous.rows[0].item_id)).rows;
        await client.query("COMMIT");
        return { item: row ? presentShoppingItem(row) : null, replayed: true };
      }

      let id: string;
      if (input.action === "add") {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO shopping_items (family_id, owner_user_id, list_name, title, quantity, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [auth.familyId, ownerUserId, input.listName ?? DEFAULT_SHOPPING_LIST, input.title, input.quantity ?? null, input.note ?? null],
        );
        id = inserted.rows[0]!.id;
      } else {
        const locked = await client.query<{ bought_at: Date | null; version: number }>(
          "SELECT bought_at, version FROM shopping_items WHERE id = $1 AND owner_user_id = $2 AND removed_at IS NULL FOR UPDATE",
          [input.id, ownerUserId],
        );
        const current = locked.rows[0];
        if (!current) throw new AppError("AGENT_SHOPPING_ITEM_NOT_FOUND", "Такого пункта в списке нет");
        if (current.version !== input.version) throw new AppError("AGENT_SHOPPING_VERSION_STALE", "Пункт уже изменили. Прочитайте список заново");
        if (input.action === "buy" && current.bought_at !== null) throw new AppError("AGENT_SHOPPING_ALREADY_BOUGHT", "Этот пункт уже отмечен купленным");
        if (input.action === "unbuy" && current.bought_at === null) throw new AppError("AGENT_SHOPPING_NOT_BOUGHT", "Этот пункт ещё не отмечен купленным");
        const changes = input.action === "remove" ? "removed_at = now()" : input.action === "buy" ? "bought_at = now()" : "bought_at = NULL";
        await client.query(`UPDATE shopping_items SET ${changes}, version = version + 1, updated_at = now() WHERE id = $1`, [input.id]);
        id = input.id!;
      }
      await client.query(
        "INSERT INTO shopping_item_operations (owner_user_id, operation_key, request_hash, item_id) VALUES ($1, $2, $3, $4)",
        [ownerUserId, operationKey, hash, id],
      );
      const [row] = (await selectItems(client, ownerUserId, { action: "list", view: "all" }, id)).rows;
      await client.query("COMMIT");
      return { item: row ? presentShoppingItem(row) : null, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
