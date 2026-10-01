/**
 * Yandex Lavka in the person's private chat: catalogue, cart, delivery address and the order.
 *
 * Exports:
 * - `yandex_lavka`: search, product, cart, add, set, clear, addresses, use_address, set_address,
 *   preview, order, orders, cancel.
 * - `yandexLavkaInput`: the same input schema for checks outside Eve.
 *
 * Key constructs:
 * - Everything runs in the person's own logged-in browser tab in their sandbox, so each family
 *   member orders from their own Lavka account and nobody's session is stored by the bot.
 * - `order` and `cancel` are gated by a Telegram confirmation; the confirmation shows the total,
 *   the address and the cart version from the preview, and the order refuses if the cart, the total,
 *   the address fingerprint or the card drifted since.
 * - `add`, `order` and `cancel` run under `runLavkaOperation`: a step Eve replays after a crash
 *   returns the stored result or an ambiguity code instead of adding or ordering twice.
 * - The delivery point is chosen once (`use_address` or `set_address`) and kept per person.
 */
import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { LAVKA_ITEM_MAX_QUANTITY } from "../lavka/lavka-config.js";
import { lavkaDeliveryPointRepository } from "../lavka/lavka-delivery-point-repository.js";
import { lavkaOperationRepository, runLavkaOperation, type LavkaOperationAction } from "../lavka/lavka-operation.js";
import { lavkaClientFor } from "../lavka/lavka-production.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";

const productId = z.string().trim().min(1).max(120);
const quantity = z.number().int().min(0).max(LAVKA_ITEM_MAX_QUANTITY);
const text = (max: number) => z.string().trim().max(max).optional();

const yandexLavkaInput = z.object({
  action: z.enum(["search", "product", "cart", "add", "set", "clear", "addresses", "use_address", "set_address", "preview", "order", "orders", "cancel"]),
  address: text(300),
  addressId: text(120),
  /** The address fingerprint from preview; the order refuses a different current address. */
  addressKey: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
  cartVersion: z.number().int().nonnegative().optional(),
  comment: text(300),
  doorcode: text(40),
  entrance: text(40),
  flat: text(40),
  floor: text(40),
  orderId: text(120),
  /** The card from preview; the order refuses when another card would be charged. */
  paymentMethodId: z.string().trim().min(1).max(120).optional(),
  /** The catalogue price from search; the site validates it on every cart write of a new product. */
  price: z.number().nonnegative().optional(),
  productId: productId.optional(),
  quantity: quantity.optional(),
  query: text(200),
  slug: text(200),
  total: z.number().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  const fields: Record<string, string[]> = {
    add: ["productId", "quantity", "price"], addresses: [], cancel: ["orderId"], cart: [], clear: [], order: ["cartVersion", "total", "addressKey", "paymentMethodId"], orders: [], preview: [],
    product: ["slug"], search: ["query"], set: ["productId", "quantity", "price"], set_address: ["address", "flat", "entrance", "floor", "doorcode", "comment"], use_address: ["addressId"],
  };
  const required: Record<string, string[]> = { add: ["productId", "price"], cancel: ["orderId"], order: ["cartVersion", "total", "addressKey", "paymentMethodId"], product: ["slug"], search: ["query"], set: ["productId", "quantity"], set_address: ["address"], use_address: ["addressId"] };
  for (const key of Object.keys(value)) {
    if (key !== "action" && (value as Record<string, unknown>)[key] !== undefined && !fields[value.action]!.includes(key)) ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
  }
  for (const key of required[value.action] ?? []) {
    if ((value as Record<string, unknown>)[key] === undefined) ctx.addIssue({ code: "custom", message: `Для ${value.action} нужно поле ${key}` });
  }
});

export type YandexLavkaInput = z.infer<typeof yandexLavkaInput>;

const APPROVAL_ACTIONS = new Set(["cancel", "order"]);

export default defineTool({
  approval: ({ toolInput }) => {
    const action = (toolInput as { action?: unknown } | null)?.action;
    return typeof action === "string" && APPROVAL_ACTIONS.has(action) ? "user-approval" : "not-applicable";
  },
  description: [
    "Яндекс Лавка из аккаунта человека в его браузере: search ищет товары (query), product показывает описание (slug из search), cart показывает корзину, add кладёт productId с его price из выдачи search (quantity по умолчанию 1, прибавляется к текущему), set ставит точное количество (0 убирает; для нового товара тоже нужен price), clear очищает.",
    "Адрес доставки нужен до поиска и заказа: addresses показывает сохранённые адреса, use_address выбирает один по addressId, set_address задаёт по тексту (address, при необходимости flat, entrance, floor, doorcode, comment).",
    "preview показывает состав, сумму, доставку, срок и карту без списания. order (cartVersion, total, addressKey и paymentMethodId ровно из preview) отправляет заказ и списывает деньги с карты аккаунта после подтверждения человека кнопкой; если сумма, корзина, адрес или карта изменились, заказ не уходит. orders показывает текущие заказы, cancel отменяет заказ (orderId) после подтверждения.",
    "Если Лавка не узнаёт вход, человеку нужно войти в Яндекс через browser_open https://passport.yandex.ru/auth и код из СМС. Цены и наличие меняются: перед order всегда свежий preview.",
  ].join(" "),
  inputSchema: yandexLavkaInput,
  async execute(input, ctx) {
    const auth = requireMemoryAuthorization(ctx);
    if (auth.groupId !== null || auth.role === "external" || auth.userId === null) {
      throw new AppError("AGENT_LAVKA_ACCESS_DENIED", "Заказы в Лавке делаются только в личном чате члена семьи");
    }
    const userId = auth.userId;
    const client = lavkaClientFor(ctx);
    const point = await lavkaDeliveryPointRepository.find(userId);
    // A step Eve replays after a crash must not add or order twice. A confirmed order or cancel is
    // bound to its call id (the approval is); an add is bound to the turn and its input, because a
    // re-run model step generates the same add under a new call id (Codex review, 28 September 2026).
    const once = async <T>(action: LavkaOperationAction, run: () => Promise<T>) => {
      const key = action === "add"
        ? `${ctx.session.id}:${ctx.session.turn.id}:add:${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32)}`
        : `${ctx.session.id}:${ctx.callId}`;
      const done = await runLavkaOperation(lavkaOperationRepository, { action, key, request: input, userId }, run);
      return done.replayed && action === "add"
        ? { ...(done.result as object), note: "Такой же add уже выполнен в этом ходе, корзина не изменена. Чтобы положить больше, используйте set с итоговым количеством" }
        : done.result;
    };
    const requirePoint = () => {
      if (!point) throw new AppError("AGENT_LAVKA_ADDRESS_REQUIRED", "Сначала выберите адрес доставки: addresses и use_address или set_address");
      return point;
    };
    switch (input.action) {
      case "search": return { point: point?.label ?? null, products: await client.search(input.query!, point) };
      case "product": return await client.product(input.slug!);
      case "cart": return await client.cart(point);
      case "add": return await once("add", () => client.addItem(requirePoint(), input.productId!, input.quantity ?? 1, input.price ?? null));
      case "set": return await client.setItem(requirePoint(), input.productId!, input.quantity!, input.price ?? null);
      case "clear": return await client.clearCart(point);
      case "addresses": return { addresses: await client.addresses(), current: point?.label ?? null };
      case "use_address": {
        const chosen = (await client.addresses()).find((a) => a.addressId === input.addressId);
        if (!chosen) throw new AppError("AGENT_LAVKA_ADDRESS_NOT_FOUND", "Такого сохранённого адреса нет: посмотрите addresses ещё раз");
        const { addressId: _addressId, fullAddress: _fullAddress, ...rest } = chosen;
        const next = { ...rest, label: chosen.label || chosen.fullAddress };
        await lavkaDeliveryPointRepository.replace({ familyId: auth.familyId, point: next, userId });
        return { point: next.label };
      }
      case "set_address": {
        const resolved = await client.resolveAddress(input.address!, point);
        const next = { ...resolved, comment: input.comment ?? "", doorcode: input.doorcode ?? "", entrance: input.entrance ?? resolved.entrance, flat: input.flat ?? "", floor: input.floor ?? "" };
        await lavkaDeliveryPointRepository.replace({ familyId: auth.familyId, point: next, userId });
        return { point: next.label, resolved: { city: next.city, house: next.house, street: next.street } };
      }
      case "preview": {
        const preview = await client.checkoutPreview(requirePoint());
        return { ...preview, address: point!.label, note: "Для order передайте cartVersion, total, addressKey и paymentMethodId ровно из этого ответа" };
      }
      case "order": {
        return await once("order", async () => {
          await requireToolApprovalEvidence(ctx, "yandex_lavka", input);
          const placed = await client.placeOrder(requirePoint(), { addressKey: input.addressKey!, cartVersion: input.cartVersion!, paymentMethodId: input.paymentMethodId!, total: input.total! });
          const note = placed.paymentStatus === "wait_user_action" ? "Банк просит подтвердить оплату (3-D Secure): откройте redirectUrl"
            : placed.paymentStatus === "unknown" ? "Заказ создан, статус оплаты не получен: проверьте orders" : "Заказ отправлен";
          return { ...placed, note };
        });
      }
      case "orders": return { orders: await client.trackedOrders() };
      case "cancel": {
        return await once("cancel", async () => {
          await requireToolApprovalEvidence(ctx, "yandex_lavka", input);
          return await client.cancelOrder(input.orderId!);
        });
      }
    }
  },
});
