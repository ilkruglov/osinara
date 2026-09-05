/** Exercise the documented patch against a real Eve pending batch, entirely in memory. */
import { describe, expect, it } from "vitest";
import { coordinateApprovalDelivery } from "../../node_modules/eve/dist/src/harness/approval-delivery-coordinator.js";
import { consumeDeferredStepInput, getPendingInputRequestIds, resolvePendingInput } from "../../node_modules/eve/dist/src/harness/input-requests.js";
import { ContextContainer, contextStorage } from "../../node_modules/eve/dist/src/context/container.js";
import { AuthKey } from "../../node_modules/eve/dist/src/context/keys.js";

describe("Eve sequential HITL decisions", () => {
  it.each(["approve", "cancel"] as const)("preserves a previous %s when the second request is approved", async (firstDecision) => {
    const requests = ["first", "second"].map((requestId) => ({
      kind: "tool-approval", display: "confirmation", requestId, prompt: requestId,
      action: { kind: "tool-call", callId: requestId, toolName: "manage_telegram_group", input: {} },
      options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
    }));
    const session = {
      history: [], state: { "eve.runtime.pendingInputBatches": [{
        event: { sequence: 1, stepIndex: 0, turnId: "turn_1" }, requests, responseMessages: [],
      }] },
    };
    const context = new ContextContainer();
    context.set(AuthKey, { authenticator: "telegram", principalId: "owner", principalType: "user", attributes: {} });
    const first = await contextStorage.run(context, () => coordinateApprovalDelivery({
      session, tools: new Map(), now: 100,
      stepInput: { inputResponses: [{ requestId: "first", optionId: firstDecision }] },
    } as never));
    const pending = resolvePendingInput({ session: first.session, stepInput: first.stepInput });
    expect(pending.outcome).toBe("unresolved");
    const next = consumeDeferredStepInput({ session: pending.session, input: {
      inputResponses: [{ requestId: "second", optionId: "approve" }],
    } } as never);
    const second = await contextStorage.run(context, () => coordinateApprovalDelivery({
      session: next.session, stepInput: next.input, tools: new Map(), now: 200,
    }));
    const resolved = resolvePendingInput({ session: second.session, stepInput: second.stepInput });
    expect(resolved.outcome).toBe("resolved");
    expect([...getPendingInputRequestIds(resolved.session.state)]).toEqual([]);
    expect(second.stepInput?.inputResponses).toEqual(expect.arrayContaining([
      { requestId: "first", optionId: firstDecision },
      { requestId: "second", optionId: "approve" },
    ]));
  });
});
