/**
 * The `yandex_lavka` tool and order watches.
 *
 * Constructs covered:
 * - A placed order is watched from the private chat it was placed in, and the answer says so.
 * - watch follows an order placed in the app from where it is now; it refuses an order that is not
 *   among the current ones; unwatch stops; neither asks for a confirmation.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  placeOrder: vi.fn(),
  requireToolApprovalEvidence: vi.fn(),
  startWatch: vi.fn(),
  stopWatch: vi.fn(),
  trackedOrders: vi.fn(),
}));

vi.mock("./lavka-production.js", () => ({ lavkaClientFor: () => ({ placeOrder: mocks.placeOrder, trackedOrders: mocks.trackedOrders }) }));
vi.mock("./lavka-delivery-point-repository.js", () => ({ lavkaDeliveryPointRepository: { find: async () => ({ label: "Дом", lat: 55.75, lon: 37.62 }) } }));
vi.mock("../require-tool-approval-evidence.js", () => ({ requireToolApprovalEvidence: mocks.requireToolApprovalEvidence }));
vi.mock("./lavka-operation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lavka-operation.js")>(),
  runLavkaOperation: async (_repository: unknown, _input: unknown, run: () => Promise<unknown>) => ({ replayed: false, result: await run() }),
}));
vi.mock("../order-watch/order-watch-start.js", () => ({ startOrderWatch: mocks.startWatch, stopOrderWatches: mocks.stopWatch }));

import yandexLavka from "../tools/yandex_lavka.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1", memoryScopes: ["personal", "family"], role: "member", telegramActorId: "101", telegramActorKind: "telegram_user",
      telegramChatId: "101", telegramChatType: "private", telegramUserId: "101",
    },
    authenticator: "telegram", principalId: "user-1", principalType: "user" as const,
  };
  return { callId: "call-1", session: { auth: { current: caller, initiator: caller }, id: "session-1", turn: { id: "turn-1", sequence: 1 } } } as unknown as ToolContext;
}

const approval = (toolInput: Record<string, unknown>) => (yandexLavka as unknown as { approval: (c: { toolInput: Record<string, unknown> }) => unknown }).approval({ toolInput });

describe("yandex_lavka order watches", () => {
  beforeEach(() => {
    mocks.startWatch.mockReset().mockResolvedValue(true);
    mocks.stopWatch.mockReset().mockResolvedValue(1);
    mocks.trackedOrders.mockReset();
    mocks.placeOrder.mockReset();
  });

  it("watches an order it placed and says so", async () => {
    mocks.placeOrder.mockResolvedValue({ orderId: "l-1", paymentStatus: "success", redirectUrl: "" });
    const placed = await yandexLavka.execute({ action: "order", addressKey: "0123456789abcdef", cartVersion: 3, paymentMethodId: "card-1", total: 990 }, context());
    expect(placed).toMatchObject({ orderId: "l-1", watching: true });
    expect((placed as { note: string }).note).toBe("Заказ отправлен. Статус пришлю сама: сборку, курьера и доставку.");
    expect(mocks.startWatch).toHaveBeenCalledWith(expect.anything(), { familyId: "family-1", initialState: null, orderId: "l-1", service: "yandex_lavka", userId: "user-1" });
  });

  it("watches an order from the app where it is now, refuses one that is not current, and stops", async () => {
    expect(approval({ action: "watch" })).toBe("not-applicable");
    expect(approval({ action: "unwatch" })).toBe("not-applicable");
    mocks.trackedOrders.mockResolvedValue([{ eta: "", orderId: "l-7", status: "assembling", subtitle: "", title: "Собираем заказ" }]);
    await expect(yandexLavka.execute({ action: "watch" }, context())).resolves.toEqual({ orderId: "l-7", status: "Собираем заказ", watching: true });
    expect(mocks.startWatch).toHaveBeenCalledWith(expect.anything(), { familyId: "family-1", initialState: { seen: true, status: "assembling" }, orderId: "l-7", service: "yandex_lavka", userId: "user-1" });
    await expect(yandexLavka.execute({ action: "watch", orderId: "l-0" }, context())).rejects.toMatchObject({ code: "AGENT_LAVKA_ORDER_NOT_FOUND" });
    await expect(yandexLavka.execute({ action: "unwatch", orderId: "l-7" }, context())).resolves.toEqual({ stopped: 1 });
    expect(mocks.stopWatch).toHaveBeenCalledWith({ orderId: "l-7", service: "yandex_lavka", userId: "user-1" });
  });
});
