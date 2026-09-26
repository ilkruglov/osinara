/**
 * Eve compaction honest-heuristic patch tests.
 *
 * Constructs covered:
 * - The tool-result cap heuristic judges itself by the real usage of the last model call minus
 *   what the cap saved, not by the character estimate of the messages: a cap that saved nothing
 *   hands over to the summary.
 * - Without a known real usage the old estimate decides, as before.
 * - A summary that still exceeds the threshold is returned as the best effort and logged, the
 *   turn does not fail.
 *
 * Production (10–25 сентября 2026): prompts of 117–140k tokens with a 120k threshold, every
 * check said "compact", the heuristic said "within limit" by an estimate that ignores the system
 * prompt and the tool schemas, and no summary ever ran.
 */
import { describe, expect, it, vi } from "vitest";

const SUMMARY = "Итог: обсуждали запись к парикмахеру.";
/** A model of the AI SDK 5 shape Eve's own bundle expects, answering one fixed summary. */
function summaryModel(text = SUMMARY) {
  const calls: number[] = [];
  return {
    calls,
    model: {
      async doGenerate() {
        calls.push(1);
        return { content: [{ text, type: "text" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      },
      async doStream() { throw new Error("not used"); },
      modelId: "summary", provider: "test", specificationVersion: "v2", supportedUrls: {},
    },
  };
}

// Eve does not export the harness; the patched runtime module is exercised directly.
const { compactMessages } = await import(`${process.cwd()}/node_modules/eve/dist/src/harness/compaction.js`) as {
  compactMessages(messages: unknown[], model: unknown, config: unknown, ...rest: unknown[]): Promise<unknown[]>;
};

const MARKER = "[Truncated by eve:";

function history(resultLength: number): unknown[] {
  return [
    { content: "привет", role: "user" },
    { content: [{ input: {}, toolCallId: "c1", toolName: "list_group_history", type: "tool-call" }], role: "assistant" },
    { content: [{ output: { type: "text", value: "x".repeat(resultLength) }, toolCallId: "c1", toolName: "list_group_history", type: "tool-result" }], role: "tool" },
    { content: "ок", role: "assistant" },
    ...Array.from({ length: 12 }, (_, i) => ({ content: `сообщение ${i}`, role: "user" })),
  ];
}
const hasSummary = (messages: unknown[]) => messages.some((m) => (m as { content: unknown }).content === SUMMARY);

describe("Eve compaction honest heuristic", () => {
  it("lets the cap stand when the real usage minus the saving fits under the threshold", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const summary = summaryModel();
    const messages = history(20_000);
    // The last call cost 3 000 tokens for all 16 messages; the cap saves ~4 500 by estimate.
    const out = await compactMessages(messages, summary.model, { lastKnownInputTokens: 3_000, lastKnownPromptMessageCount: messages.length, recentWindowSize: 10, threshold: 2_500, thresholdPercent: 0.75 });
    expect(summary.calls).toHaveLength(0);
    expect(hasSummary(out)).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"code":"AGENT_COMPACTION_HEURISTIC"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"within":true'));
    info.mockRestore();
  });

  it("hands over to the summary when the cap saves nothing against the real usage", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const summary = summaryModel();
    const messages = history(20_000);
    const capped = await compactMessages(messages, summary.model, { recentWindowSize: 10, threshold: 1e9, thresholdPercent: 0.75 });
    expect(JSON.stringify(capped)).toContain(MARKER);
    expect(summary.calls).toHaveLength(0);
    // The next call still cost 130 000 real tokens over a 120 000 threshold: capping again saves nothing.
    const out = await compactMessages(capped, summary.model, { lastKnownInputTokens: 130_000, lastKnownPromptMessageCount: capped.length, recentWindowSize: 10, threshold: 120_000, thresholdPercent: 0.75 });
    expect(summary.calls).toHaveLength(1);
    expect(hasSummary(out)).toBe(true);
    vi.restoreAllMocks();
  });

  it("keeps the estimate-only decision when no real usage is known", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const summary = summaryModel();
    const out = await compactMessages(history(20_000), summary.model, { recentWindowSize: 10, threshold: 1e9, thresholdPercent: 0.75 });
    expect(summary.calls).toHaveLength(0);
    expect(JSON.stringify(out)).toContain(MARKER);
    vi.restoreAllMocks();
  });

  it("returns the best summary instead of failing the turn when it still exceeds the threshold", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = summaryModel(SUMMARY + " и ещё".repeat(2_000));
    const messages = history(20_000);
    const out = await compactMessages(messages, summary.model, { lastKnownInputTokens: 130_000, lastKnownPromptMessageCount: messages.length, recentWindowSize: 10, threshold: 120, thresholdPercent: 0.75 });
    expect(summary.calls).toHaveLength(1);
    expect(out.length).toBeGreaterThan(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_COMPACTION_OUTPUT_OVER_LIMIT"));
    vi.restoreAllMocks();
  });
});
