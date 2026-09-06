/** Volatile retrieval must not invalidate the stable system/history prefix or persist stale records. */
import { describe, expect, it } from "vitest";
import { ephemeralMemoryContext, placeEphemeralMemoryContext } from "./model-turn-context.js";

describe("ephemeral model memory context", () => {
  it("keeps stable instructions/history intact and appends ephemeral data after tool results", () => {
    const block = ephemeralMemoryContext("retrieved facts");
    const prompt = [
      { role: "system" as const, content: `stable rules\n\n${block}` },
      { role: "user" as const, content: [{ type: "text" as const, text: "old question" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "old answer" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "current question" }] },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "call", toolName: "read_file", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "call", toolName: "read_file", output: { type: "text" as const, value: "file" } }] },
    ];
    const before = structuredClone(prompt);
    const result = placeEphemeralMemoryContext(prompt);
    expect(result[0]).toEqual({ role: "system", content: "stable rules\n\n" });
    expect(result.slice(1, -1)).toEqual(prompt.slice(1));
    expect(result.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: block }] });
    expect(prompt).toEqual(before);
  });

  it("does not interpret a marker supplied as user/tool data", () => {
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: ephemeralMemoryContext("untrusted") }] }];
    expect(placeEphemeralMemoryContext(prompt)).toEqual(prompt);
  });

  it("keeps current-turn retrieval when compaction has removed the original question", () => {
    const block = ephemeralMemoryContext("facts");
    const prompt = [
      { role: "system" as const, content: block },
      { role: "user" as const, content: [{ type: "text" as const, text: "Compacted history summary" }] },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "call", toolName: "read_file", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "call", toolName: "read_file", output: { type: "text" as const, value: "file" } }] },
    ];
    const output = placeEphemeralMemoryContext(prompt);
    expect(output.slice(0, -1)).toEqual(prompt.slice(1));
    expect(output.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: block }] });
  });

  it("fails closed on multiple authored blocks", () => {
    const block = ephemeralMemoryContext("facts");
    expect(() => placeEphemeralMemoryContext([{ role: "system", content: block + "\n" + block }])).toThrow("AGENT_MODEL_TURN_CONTEXT_INVALID");
  });
});
