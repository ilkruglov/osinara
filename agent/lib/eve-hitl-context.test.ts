/** HITL context must not hide the approval response tail required by AI SDK. */
import { generateText, jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { resolvePendingInput, hasDeferredStepInput } from "../../node_modules/eve/dist/src/harness/input-requests.js";
import type { HarnessSession } from "../../node_modules/eve/dist/src/harness/types.js";
import { MockLanguageModelV4 } from "ai/test";

function pendingSession(): HarnessSession {
  const requests = ["first", "second"].map((requestId) => ({
    kind: "tool-approval", display: "confirmation", requestId, prompt: requestId,
    action: { kind: "tool-call", callId: requestId, toolName: "change", input: { id: requestId } },
    options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
  }));
  return {
    history: [{ role: "user", content: "Do two changes" }],
    state: { "eve.runtime.pendingInputBatches": [{
      event: { sequence: 1, stepIndex: 0, turnId: "turn_1" }, requests,
      responseMessages: [{ role: "assistant", content: requests.flatMap((request) => [
        { type: "tool-call", toolCallId: request.requestId, toolName: "change", input: request.action.input },
        { type: "tool-approval-request", approvalId: request.requestId, toolCallId: request.requestId },
      ]) }],
    }] },
  } as unknown as HarnessSession;
}

describe("Eve approval continuation context", () => {
  it("executes the approved action once while explaining cancellation of the other without another turn", async () => {
    const context = ["The second action timed out; it must not run."];
    const session = pendingSession();
    const resolved = resolvePendingInput({ session, stepInput: { context, inputResponses: [
      { requestId: "first", optionId: "approve" }, { requestId: "second", optionId: "cancel" },
    ] } });
    expect(resolved.outcome).toBe("resolved");
    expect(hasDeferredStepInput(resolved.session)).toBe(false);
    expect(resolved).toHaveProperty("osinaraConsumedContext", true);
    expect(resolved.messages[1]).toEqual({ role: "user", content: context[0] });
    expect(resolved.messages.at(-1)?.role).toBe("tool");
    expect(session.history).toEqual([{ role: "user", content: "Do two changes" }]);

    const execute = vi.fn(async (_input: { id: string }) => "changed");
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: "text", text: "First done; second cancelled." }],
      finishReason: { unified: "stop", raw: "stop" }, warnings: [],
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
    }) });
    await generateText({ model, messages: resolved.messages, tools: {
      change: { inputSchema: jsonSchema<{ id: string }>({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }), execute },
    } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual({ id: "first" });
  });

  it("consumes context with a textual approval, but still defers an unrelated new message", () => {
    const session = pendingSession();
    const batch = (session.state!["eve.runtime.pendingInputBatches"] as { requests: unknown[] }[])[0]!;
    batch.requests.splice(1);
    const resolved = resolvePendingInput({ session, stepInput: { message: "approve", context: ["Verified reply metadata"] } });
    expect(resolved.consumedMessage).toBe(true);
    expect(resolved).toHaveProperty("osinaraConsumedContext", true);
    expect(hasDeferredStepInput(resolved.session)).toBe(false);
    expect(resolved.messages.at(-1)?.role).toBe("tool");

    const next = resolvePendingInput({ session, stepInput: { message: "A new task", context: ["New message metadata"],
      inputResponses: [{ requestId: "first", optionId: "approve" }],
    } });
    expect(next.deferredMessage).toBe(true);
    expect(next.deferredContext).toBe(true);
    expect(next).not.toHaveProperty("osinaraConsumedContext", true);
    expect(hasDeferredStepInput(next.session)).toBe(true);
    expect(next.messages.filter((message: ModelMessage) => message.role === "user")).toEqual(session.history);
  });
});
