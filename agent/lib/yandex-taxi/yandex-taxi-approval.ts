/**
 * The Telegram confirmation window of a Yandex Go order or cancellation.
 *
 * Export:
 * - `yandexTaxiApprovalPrompt`: the window text, built only from the tool input that will execute.
 *
 * Key constructs:
 * - The input is parsed with the tool's own schema, and each route point must still match its key,
 *   so the addresses shown are the coordinates the order carries.
 * - Everything shown is re-checked at execution against a fresh answer from Yandex Go (a price no
 *   higher than shown, the currency, fixed price, tariff name, payment label, cancellation terms); a
 *   mismatch refuses the action instead of running something the person did not see. The pickup time
 *   is an estimate and is labelled so.
 */
import { AppError } from "../app-error.js";
import { approvalFact, buildApprovalMessage } from "../telegram-hitl/approval-message.js";
import { yandexTaxiInput } from "./yandex-taxi-input.js";
import { requireYandexTaxiPoint, YANDEX_TAXI_CANCEL_LABELS, yandexTaxiMaxPrice, type YandexTaxiPoint } from "./yandex-taxi-model.js";

const invalid = () => new AppError("AGENT_APPROVAL_SUBJECT_INVALID", "Не удалось определить заказ такси для подтверждения");

/**
 * The full address with its city: a short text such as «Тверская 1» exists in many cities, and the
 * order carries the coordinates of exactly one of them (Codex review, 24 October 2026).
 */
function place(point: YandexTaxiPoint, porch?: string): string {
  const address = point.fullText || point.shortText;
  const city = point.city && !address.toLocaleLowerCase("ru").includes(point.city.toLocaleLowerCase("ru")) ? `${point.city}, ` : "";
  return `${city}${address}${porch ? `, подъезд ${porch}` : ""}`;
}

export function yandexTaxiApprovalPrompt(raw: unknown): string {
  const parsed = yandexTaxiInput.safeParse(raw);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  if (input.action === "cancel") {
    if (!input.orderId || !input.cancelState) throw invalid();
    const terms = YANDEX_TAXI_CANCEL_LABELS[input.cancelState];
    return buildApprovalMessage({
      actionLabel: `отменить заказ такси Яндекс Go ${terms === YANDEX_TAXI_CANCEL_LABELS.free ? "бесплатно" : `(${terms})`}`,
      consequence: "Яндекс Go отменит заказ. Если отмена платная, он спишет плату по своим правилам. Если условия отмены изменились после проверки, отмена не уйдёт.",
      facts: [
        ...approvalFact("Заказ", input.orderId),
        ...approvalFact("Отмена", terms),
        ...(input.cancelState === "free" ? [] : approvalFact("Условия Яндекс Go", input.cancelMessage ?? "")),
      ],
    });
  }
  if (input.action !== "order" || !input.from || !input.to || !input.payment?.label || input.price === undefined || !input.currency || input.fixedPrice === undefined || !input.tariff || !input.tariffName) {
    throw invalid();
  }
  const from = requireYandexTaxiPoint(input.from, "from");
  const to = requireYandexTaxiPoint(input.to, "to");
  const price = `${input.fixedPrice ? "" : "≈ "}${input.price} ${input.currency}`;
  const ceiling = `${yandexTaxiMaxPrice(input.price)} ${input.currency}`;
  return buildApprovalMessage({
    actionLabel: `заказать такси Яндекс Go за ${price}`,
    consequence: input.fixedPrice
      ? `Перед заказом я пересчитаю цену: Яндекс Go меняет её каждые несколько секунд. Если она будет не выше ${ceiling}, Яндекс Go начнёт искать машину и возьмёт пересчитанную цену выбранным способом оплаты. Если выше или условия изменились, заказ не уйдёт.`
      : `Перед заказом я пересчитаю оценку. Если она будет не выше ${ceiling}, Яндекс Go начнёт искать машину; цена не фиксированная, итог посчитает Яндекс Go по поездке. Если выше или условия изменились, заказ не уйдёт.`,
    facts: [
      ...approvalFact("Откуда", place(from, input.porch)),
      ...approvalFact("Куда", place(to)),
      ...approvalFact("Тариф", input.tariffName),
      ...approvalFact("Цена", `${price}, ${input.fixedPrice ? "фиксированная" : "не фиксированная"}`),
      ...approvalFact("Не дороже", ceiling),
      ...approvalFact("Подача", typeof input.waitingMinutes === "number" ? `примерно через ${input.waitingMinutes} мин (оценка)` : "Яндекс Go не оценил"),
      ...approvalFact("Оплата", input.payment.label),
      ...approvalFact("Комментарий водителю", input.comment ?? ""),
    ],
  });
}
