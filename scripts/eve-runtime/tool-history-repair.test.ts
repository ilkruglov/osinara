/**
 * Answering tool calls that would otherwise reach the model without a result.
 *
 * Constructs covered:
 * - `repairOrphanedToolCalls`: a call with no result anywhere gets an error result right after its
 *   assistant message, so a history the AI SDK rejects with `MissingToolResultsError` passes the
 *   SDK's own prompt check; provider-executed calls, calls with a result anywhere, calls with an
 *   approval request or response, and duplicate call ids are left alone.
 * - `logRepair`: the prompt is repaired on every step until the call leaves the history, but the
 *   repair is logged once per session and set of calls, within a bounded memory.
 *
 * - `splitParkedResponse`: when a step parks on a new approval, the results of work resumed at the
 *   start of that step (the leading tool messages) are committed to the history; only the rest
 *   waits with the approval batch.
 *
 * Ported from Eve 1.0 (f5b36b3 and 4264f03) on 13 November 2026.
 */
import { convertToLanguageModelPrompt } from "ai/internal";
import { describe, expect, it, vi } from "vitest";

import { logRepair, repairOrphanedToolCalls, splitParkedResponse } from "./tool-history-repair.ts";

const call = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  input: {},
  toolCallId,
  toolName: "bash",
  type: "tool-call",
  ...extra,
});
const result = (toolCallId: string) => ({
  output: { type: "text", value: "ok" },
  toolCallId,
  toolName: "bash",
  type: "tool-result",
});

async function sdkAccepts(messages: readonly unknown[]): Promise<boolean> {
  try {
    await convertToLanguageModelPrompt({
      download: undefined,
      prompt: { messages } as never,
      supportedUrls: {},
    });
    return true;
  } catch (error) {
    if ((error as Error).name === "AI_MissingToolResultsError") return false;
    throw error;
  }
}

describe("repairOrphanedToolCalls", () => {
  it("answers an orphaned call so the AI SDK accepts the history", async () => {
    const history = [
      { content: "запусти", role: "user" },
      { content: [call("lost"), call("kept")], role: "assistant" },
      { content: [result("kept")], role: "tool" },
      { content: "ну что там?", role: "user" },
    ];
    expect(await sdkAccepts(history)).toBe(false);
    const { messages, repaired } = repairOrphanedToolCalls(history);
    expect(repaired).toEqual(["lost"]);
    expect(await sdkAccepts(messages)).toBe(true);
    const tool = messages[2] as { content: Array<{ toolCallId: string; output: unknown }> };
    expect(tool.content.map((part) => part.toolCallId)).toEqual(["kept", "lost"]);
    expect(JSON.stringify(tool.content[1]!.output)).toContain("исход неизвестен");
    // The input is not changed.
    expect((history[2] as { content: unknown[] }).content).toHaveLength(1);
  });

  it("adds a tool message when the call has none after it", async () => {
    const history = [
      { content: [call("lost")], role: "assistant" },
      { content: "дальше", role: "user" },
    ];
    const { messages } = repairOrphanedToolCalls(history);
    expect(messages.map((message) => (message as { role: string }).role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
    expect(await sdkAccepts(messages)).toBe(true);
  });

  it("leaves provider-executed, answered, approval and duplicate calls alone", () => {
    const history = [
      {
        content: [
          call("provider", { providerExecuted: true }),
          call("answered-late"),
          call("asked", {}),
          { approvalId: "a1", toolCall: { toolCallId: "asked" }, type: "tool-approval-request" },
          call("asked-bare"),
          { approvalId: "a2", toolCallId: "asked-bare", type: "tool-approval-request" },
          call("dup"),
          call("dup"),
        ],
        role: "assistant",
      },
      { content: "между", role: "user" },
      { content: [result("answered-late")], role: "tool" },
    ];
    const { messages, repaired } = repairOrphanedToolCalls(history);
    expect(repaired).toEqual([]);
    expect(messages).toBe(history);
  });
});

describe("logRepair", () => {
  const logged = () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => {
      const lines = error.mock.calls.map((call) => String(call[0]));
      error.mockRestore();
      return lines;
    };
  };

  it("logs a repair once per session and set of calls", () => {
    const done = logged();
    logRepair("s1", ["a"]);
    logRepair("s1", ["a"]);
    logRepair("s1", ["a", "b"]);
    logRepair("s2", ["a"]);
    logRepair("s3", []);
    const lines = done();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      code: "AGENT_TOOL_HISTORY_REPAIRED",
      sessionId: "s1",
      toolCallIds: ["a"],
    });
  });

  it("forgets the oldest sessions past its bound", () => {
    const done = logged();
    for (let i = 0; i < 1_100; i += 1) logRepair(`bulk-${i}`, ["x"]);
    logRepair("bulk-0", ["x"]);
    logRepair("bulk-1099", ["x"]);
    expect(done()).toHaveLength(1_101);
  });
});

describe("splitParkedResponse", () => {
  it("commits the results of resumed work and keeps the new request pending", () => {
    const resumed = { content: [result("first")], role: "tool" };
    const asking = { content: [call("second")], role: "assistant" };
    expect(splitParkedResponse([resumed, asking])).toEqual({
      committed: [resumed],
      pending: [asking],
    });
    expect(splitParkedResponse([asking])).toEqual({ committed: [], pending: [asking] });
    expect(splitParkedResponse([resumed])).toEqual({ committed: [resumed], pending: [] });
  });
});
