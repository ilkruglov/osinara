/**
 * The input of the `yandex_taxi` tool, shared by the tool and its confirmation window.
 *
 * Exports:
 * - `yandexTaxiInput`: one object schema (its root must stay an object for DeepSeek) with the
 *   allowed and required fields checked per action.
 * - `YandexTaxiInput`, `YANDEX_TAXI_APPROVAL_ACTIONS`.
 *
 * Key construct:
 * - The confirmation window is built from this exact input, and execution compares the same input
 *   with a fresh answer from Yandex Go, so the window cannot show one ride while another is ordered.
 */
import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).optional();

const point = z.object({
  city: z.string().max(100),
  fullText: z.string().max(300),
  key: z.string().regex(/^[0-9a-f]{16}$/u),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  shortText: z.string().min(1).max(200),
  uri: z.string().max(300),
}).strict();

const payment = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  type: z.enum(["card", "cash", "yandex_card"]),
}).strict();

export const yandexTaxiInput = z.object({
  action: z.enum(["auth", "places", "suggest", "estimate", "order", "status", "cancel", "watch", "unwatch"]),
  cancelMessage: text(500),
  cancelState: z.enum(["free", "minimal", "paid", "unknown"]).optional(),
  comment: text(200),
  currency: z.string().trim().min(1).max(20).optional(),
  fixedPrice: z.boolean().optional(),
  from: point.optional(),
  near: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict().optional(),
  orderId: z.string().trim().min(1).max(100).optional(),
  payment: payment.optional(),
  pick: z.number().int().min(0).max(4).optional(),
  porch: text(20),
  price: z.number().nonnegative().optional(),
  query: text(200),
  tariff: z.string().trim().min(1).max(60).optional(),
  tariffName: z.string().trim().min(1).max(100).optional(),
  to: point.optional(),
  type: z.enum(["from", "to"]).optional(),
  waitingMinutes: z.number().int().min(0).max(600).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  const allowed: Record<typeof value.action, string[]> = {
    auth: [], cancel: ["orderId", "cancelState", "cancelMessage"], estimate: ["from", "to", "payment"],
    order: ["from", "to", "payment", "tariff", "tariffName", "price", "currency", "fixedPrice", "waitingMinutes", "porch", "comment"],
    places: [], status: ["orderId"], suggest: ["query", "type", "near", "pick"], unwatch: ["orderId"], watch: ["orderId"],
  };
  const required: Partial<Record<typeof value.action, string[]>> = {
    cancel: ["orderId", "cancelState"], estimate: ["from", "to"],
    order: ["from", "to", "payment", "tariff", "tariffName", "price", "currency", "fixedPrice"], suggest: ["type"],
  };
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "action" && fields[key] !== undefined && !allowed[value.action].includes(key)) ctx.addIssue({ code: "custom", message: `Недопустимое поле ${key} для ${value.action}` });
  }
  for (const key of required[value.action] ?? []) {
    if (fields[key] === undefined) ctx.addIssue({ code: "custom", message: `Для ${value.action} нужно поле ${key}` });
  }
  // An address comes from text, or from a location the person shared (near alone): the pin drop
  // names one address, so there is nothing to pick from.
  if (value.action === "suggest" && value.query === undefined && value.near === undefined) {
    ctx.addIssue({ code: "custom", message: "Для suggest нужен query (адрес текстом) или near (геолокация)" });
  }
  if (value.action === "suggest" && value.query === undefined && value.pick !== undefined) {
    ctx.addIssue({ code: "custom", message: "pick только вместе с query" });
  }
  // The window names the method by its label; a card is found by its id.
  if (value.action === "order" && value.payment && (!value.payment.label || (value.payment.type !== "cash" && !value.payment.id))) {
    ctx.addIssue({ code: "custom", message: "Для order нужен payment ровно из estimate: type, id и label" });
  }
});

export type YandexTaxiInput = z.infer<typeof yandexTaxiInput>;

export const YANDEX_TAXI_APPROVAL_ACTIONS: ReadonlySet<string> = new Set(["cancel", "order"]);
