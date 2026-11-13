/**
 * Eve compaction: a blank summary and how oversized tool output is cut.
 *
 * Constructs covered:
 * - A blank summary from the compaction model is a `CompactionBlankSummaryError` and the history
 *   is not touched; before, it replaced the whole history with an empty checkpoint (Eve 1.0
 *   1807ff9). `maybeCompact` catches exactly that error, logs `AGENT_COMPACTION_EMPTY_SUMMARY` and
 *   goes on with the history as it was: no todo note appended, no file-read state cleared, no
 *   `compaction.completed`. A manual (forced) compaction lets it reach its own failure handler,
 *   which keeps the session and its token counters.
 * - An oversized tool result keeps its start and its end (where the error and the exit code
 *   are), and never splits a surrogate pair (Eve 0.52.2 and a3654ef), both when old results are
 *   capped in the history and when the transcript for the summary is rendered.
 *
 * Ported from Eve 1.0 on 13 November 2026.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { codeText, topLevelFunction } from "./vendored-code.js";

/** A model of the AI SDK 5 shape Eve's own bundle expects, answering one fixed text. */
function textModel(text: string) {
  const calls: number[] = [];
  return {
    calls,
    model: {
      async doGenerate() {
        calls.push(1);
        return {
          content: [{ text, type: "text" }],
          finishReason: "content-filter",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("not used");
      },
      modelId: "summary",
      provider: "test",
      specificationVersion: "v2",
      supportedUrls: {},
    },
  };
}

// Eve does not export the harness; the patched runtime modules are exercised directly.
const { compactMessages } = (await import(
  `${process.cwd()}/node_modules/eve/dist/src/harness/compaction.js`
)) as {
  compactMessages(messages: unknown[], model: unknown, ...rest: unknown[]): Promise<unknown[]>;
};
const { createCompactionPrompt } = (await import(
  `${process.cwd()}/node_modules/eve/dist/src/harness/compaction-prompt.js`
)) as {
  createCompactionPrompt(input: {
    messages: unknown[];
    previousCheckpoint?: string;
    transcriptBudgetTokens?: number;
  }): { prompt: string; system: string };
};

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
// An odd count of one-unit characters before the emoji puts a pair across every even cut.
const OUTPUT = `x${"😀".repeat(1_500)} exitCode: 1 TAIL_ERROR`;

function history(output: string): unknown[] {
  return [
    { content: "запусти тесты", role: "user" },
    {
      content: [{ input: {}, toolCallId: "c1", toolName: "bash", type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: output },
          toolCallId: "c1",
          toolName: "bash",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    { content: "упало", role: "assistant" },
    ...Array.from({ length: 12 }, (_, i) => ({ content: `сообщение ${i}`, role: "user" })),
  ];
}

function cappedOutput(messages: unknown[]): string {
  for (const message of messages as Array<{ content: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ output?: { value?: unknown } }>) {
      const value = part.output?.value;
      if (typeof value === "string" && value.startsWith("[Truncated by eve:")) return value;
    }
  }
  throw new Error("no capped tool result");
}

describe("Eve compaction blank summary and clipping", () => {
  it("refuses a blank summary without touching the history", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const blank of ["", " \n\t"]) {
      const summary = textModel(blank);
      const messages = history("short");
      const original = structuredClone(messages);
      // Forced: straight to the summary, no cap heuristic first.
      await expect(
        compactMessages(
          messages,
          summary.model,
          { recentWindowSize: 10, threshold: 1e9, thresholdPercent: 0.75 },
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toMatchObject({ name: "CompactionBlankSummaryError" });
      expect(summary.calls).toHaveLength(1);
      expect(messages).toEqual(original);
    }
    vi.restoreAllMocks();
  });

  it("goes on with the history as it was when the summary is blank", async () => {
    const source = await readFile("vendor/eve/dist/src/harness/tool-loop.js", "utf8");
    // The class is imported, or `instanceof` throws a ReferenceError for every compaction error.
    expect(source).toMatch(
      /import \{[^}]*\bCompactionBlankSummaryError\b[^}]*\} from "#harness\/compaction\.js";/u,
    );
    const body = codeText(topLevelFunction(source, "maybeCompact"));
    expect(body).toContain(codeText("instanceof CompactionBlankSummaryError"));
    // A manual (forced) compaction hands the error to its own failure handler, which keeps the
    // session and its token counters as they were (Codex review, 13 November 2026).
    expect(body).toContain(
      codeText("if (!(o instanceof CompactionBlankSummaryError) || e.force === !0) throw o;"),
    );
    expect(body).toContain(codeText('code: "AGENT_COMPACTION_EMPTY_SUMMARY"'));
    // The early return comes before the framework-state hook and the completed event.
    const caught = body.indexOf(codeText("instanceof CompactionBlankSummaryError"));
    expect(caught).toBeLessThan(body.indexOf(codeText("e.onCompaction")));
    expect(caught).toBeLessThan(body.indexOf(codeText("createCompactionCompletedEvent")));
  });

  it("caps an old tool result to its start and its end without splitting a pair", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const out = await compactMessages(history(OUTPUT), textModel("итог").model, {
      recentWindowSize: 10,
      threshold: 1e9,
      thresholdPercent: 0.75,
    });
    const capped = cappedOutput(out);
    expect(capped).toContain("TAIL_ERROR");
    expect(capped).toContain("chars omitted");
    expect(capped).not.toMatch(LONE_SURROGATE);
    vi.restoreAllMocks();
  });

  it("renders the summary transcript with the end of a long result and whole characters", () => {
    const { prompt } = createCompactionPrompt({ messages: history(OUTPUT) });
    expect(prompt).toContain("TAIL_ERROR");
    expect(prompt).not.toMatch(LONE_SURROGATE);
    const long = createCompactionPrompt({
      messages: [{ content: `y${"😀".repeat(3_000)}`, role: "user" }],
      transcriptBudgetTokens: 10,
    });
    expect(long.prompt).not.toMatch(LONE_SURROGATE);
  });
});
