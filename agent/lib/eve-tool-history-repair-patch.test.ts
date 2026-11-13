/**
 * Eve tool-loop: tool calls never reach the model without a result.
 *
 * Constructs covered (the behaviour itself: `scripts/eve-runtime/tool-history-repair.test.ts`):
 * - The prompt messages of every model call pass through `repairOrphanedToolCalls`, and a repair
 *   is logged once per session and set of calls (`logRepair`, `AGENT_TOOL_HISTORY_REPAIRED`).
 * - Both parkings on an approval commit the results of resumed work to the history ahead of the
 *   pending-approval note and keep only the rest with the batch (`splitParkedResponse`); before,
 *   the resumed turn ran the first approved tool again.
 *
 * Ported from Eve 1.0 (f5b36b3 and 4264f03) on 13 November 2026.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { codeText } from "./vendored-code.js";

const TOOL_LOOP_PATH = "vendor/eve/dist/src/harness/tool-loop.js";

describe("Eve tool history repair patch", () => {
  it("repairs the prompt of every model call and logs a repair once", async () => {
    const runtime = codeText(await readFile(TOOL_LOOP_PATH, "utf8"));
    expect(runtime).toContain(codeText('from "./osinara-tool-history-repair.js"'));
    expect(runtime).toContain(codeText("let osinaraRepair = repairOrphanedToolCalls(Y);"));
    expect(runtime).toContain(codeText("let X = osinaraRepair.messages,"));
    expect(runtime).toContain(codeText("logRepair(E.sessionId, osinaraRepair.repaired);"));
  });

  it("commits resumed results to the history when a step parks on an approval", async () => {
    const runtime = codeText(await readFile(TOOL_LOOP_PATH, "utf8"));
    expect(runtime).toContain(codeText("osinaraParked = splitParkedResponse(g),"));
    expect(runtime).toContain(codeText("...r, ...osinaraParked.committed,"));
    const parked = codeText(
      "responseMessages: osinaraParked.pending, session: { ...v, history: w },",
    );
    expect(runtime.split(parked)).toHaveLength(3);
    expect(runtime).not.toContain(codeText("responseMessages: g, session: { ...v, history: w },"));
  });
});
