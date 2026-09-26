/**
 * The ВкусВилл catalogue and a cart link, in the person's private chat.
 *
 * Exports:
 * - `grocery_cart`: search, one product's details, a link to an assembled cart.
 * - `groceryCartInput`: the same input schema for checks outside Eve.
 *
 * The tool only reads the catalogue and asks the source to assemble a cart. The person places the
 * order by opening the link: the bot has no access to their account, address or payment. Only the
 * search text reaches the third-party server.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  GROCERY_BATCH_ITEMS_PER_QUERY,
  GROCERY_CART_MAX_ITEMS,
  GROCERY_CART_MAX_QUANTITY,
  GROCERY_CART_MIN_QUANTITY,
  GROCERY_SEARCH_MAX_ITEMS,
  GROCERY_SEARCH_MAX_QUERIES,
} from "../grocery/grocery-config.js";
import { groceryCartLink, groceryDetails, groceryItems } from "../grocery/grocery-presentation.js";
import { callGroceryCatalog } from "../grocery/grocery-throttle.js";
import { requireMemoryAuthorization } from "../memory-context.js";

const productId = z.number().int().positive().max(999_999_999);

export const groceryCartInput = z.object({
  action: z.enum(["search", "details", "link"]),
  items: z.array(z.object({
    productId,
    quantity: z.number().min(GROCERY_CART_MIN_QUANTITY).max(GROCERY_CART_MAX_QUANTITY),
  })).min(1).max(GROCERY_CART_MAX_ITEMS).optional(),
  page: z.number().int().min(1).max(99).optional(),
  productId: productId.optional(),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(GROCERY_SEARCH_MAX_QUERIES).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["price_asc", "price_desc", "rating", "popularity", "new"]).optional(),
}).strict().superRefine((value, ctx) => {
  const fields: Record<string, string[]> = { details: ["productId"], link: ["items"], search: ["queries", "query", "sort", "page"] };
  for (const key of Object.keys(value)) {
    if (key !== "action" && !fields[value.action]!.includes(key)) ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
  }
  if (value.action === "search" && !value.query && !value.queries) ctx.addIssue({ code: "custom", message: "Для search нужен query или queries" });
  if (value.query && value.queries) ctx.addIssue({ code: "custom", message: "Передайте либо query, либо queries" });
  if (value.queries && value.page !== undefined) ctx.addIssue({ code: "custom", message: "page работает только с одним query" });
  if (value.action === "details" && value.productId === undefined) ctx.addIssue({ code: "custom", message: "Для details нужен productId из search" });
  if (value.action === "link" && !value.items) ctx.addIssue({ code: "custom", message: "Для link нужен items" });
});

export default defineTool({
  description: [
    "Каталог продуктов ВкусВилла: search находит товары, details показывает состав и КБЖУ одного товара, link собирает корзину и возвращает ссылку на неё.",
    `search: query для одного названия или queries до ${GROCERY_SEARCH_MAX_QUERIES} названий сразу (весь список покупок одним вызовом, по ${GROCERY_BATCH_ITEMS_PER_QUERY} варианта на название); sort price_asc|price_desc|rating|popularity|new, page только с одним query.`,
    "details: productId из выдачи search.",
    `link: items от одной до ${GROCERY_CART_MAX_ITEMS} позиций, каждая productId и quantity (${GROCERY_CART_MIN_QUANTITY}..${GROCERY_CART_MAX_QUANTITY}). Возвращает ссылку на корзину.`,
    "Ссылку отправь человеку целиком и скажи, что заказ он оформляет сам: адрес доставки и оплата остаются у него. Цены и наличие могут измениться к моменту заказа, итоговую сумму не обещай.",
  ].join(" "),
  inputSchema: groceryCartInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (auth.groupId !== null || auth.role === "external" || auth.userId === null) {
      throw new AppError("AGENT_GROCERY_ACCESS_DENIED", "Корзина продуктов собирается только в личном чате члена семьи");
    }
    if (input.action === "search") {
      const sort = input.sort ?? "popularity";
      if (input.queries) {
        // Queries go one by one: the source has one shared rate limit, and a volley would only bring the refusal sooner.
        const found: { query: string; items: unknown }[] = [];
        for (const query of input.queries) {
          const result = await callGroceryCatalog("vkusvill_products_search", { mode: "short", page: 1, q: query, sort });
          found.push({ items: groceryItems(result, GROCERY_BATCH_ITEMS_PER_QUERY), query });
        }
        return { found };
      }
      return groceryItems(await callGroceryCatalog("vkusvill_products_search", { mode: "short", page: input.page ?? 1, q: input.query!, sort }), GROCERY_SEARCH_MAX_ITEMS);
    }
    if (input.action === "details") {
      return groceryDetails(await callGroceryCatalog("vkusvill_product_details", { id: input.productId! }));
    }
    // The same product twice is two positions to the source: merged here.
    const merged = new Map<number, number>();
    for (const item of input.items!) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
    if (merged.size > GROCERY_CART_MAX_ITEMS) throw new AppError("AGENT_GROCERY_CART_TOO_LARGE", `В одну ссылку помещается не больше ${GROCERY_CART_MAX_ITEMS} позиций`);
    const products = [...merged].map(([id, quantity]) => {
      if (quantity > GROCERY_CART_MAX_QUANTITY) throw new AppError("AGENT_GROCERY_QUANTITY_TOO_LARGE", `Общее количество одного товара превышает ${GROCERY_CART_MAX_QUANTITY}. Уточните количество`);
      return { q: Number(quantity.toFixed(2)), xml_id: id };
    });
    return { link: groceryCartLink(await callGroceryCatalog("vkusvill_cart_link_create", { products })), positions: products.length };
  },
});
