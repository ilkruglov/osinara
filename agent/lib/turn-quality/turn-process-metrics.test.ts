/**
 * Turn process metrics tests.
 *
 * Constructs covered:
 * - The longest run of identical consecutive calls (tool and input) is the loop signal; a changed
 *   input breaks the run.
 * - A call repeated unchanged after it failed is the repeat-after-error signal; a changed retry is not.
 * - A forbidden tool is one whose failure code says so.
 */
import { describe, expect, it } from "vitest";

import { turnProcessMetrics } from "./turn-process-metrics.js";

const call = (toolName: string, inputHash: string, code: string | null = null) => ({ code, inputHash, toolName });

describe("turnProcessMetrics", () => {
  it("measures the longest run of identical consecutive calls", () => {
    expect(turnProcessMetrics([call("list_group_history", "a"), call("list_group_history", "a"), call("list_group_history", "a"), call("remember", "b")]))
      .toMatchObject({ repeatedCallRun: 3 });
    expect(turnProcessMetrics([call("list_group_history", "a"), call("list_group_history", "b")])).toMatchObject({ repeatedCallRun: 1 });
    expect(turnProcessMetrics([])).toEqual({ forbiddenTool: false, repeatAfterError: false, repeatedCallRun: 0 });
  });

  it("flags an unchanged repeat after a failure, not a changed retry", () => {
    expect(turnProcessMetrics([call("yandex_lavka", "a", "AGENT_LAVKA_AUTH_REQUIRED"), call("yandex_lavka", "a")])).toMatchObject({ repeatAfterError: true });
    expect(turnProcessMetrics([call("remember", "a", "AGENT_MEMORY_SLOT_REVIEW_REQUIRED"), call("list_memories", "x"), call("remember", "b")])).toMatchObject({ repeatAfterError: false });
    expect(turnProcessMetrics([call("remember", "a", "E"), call("list_memories", "x"), call("remember", "a")])).toMatchObject({ repeatAfterError: true });
  });

  it("flags a forbidden tool by its failure code", () => {
    expect(turnProcessMetrics([call("bash", "a", "AGENT_GROUP_TOOL_FORBIDDEN")])).toMatchObject({ forbiddenTool: true });
    expect(turnProcessMetrics([call("web_fetch", "a", "AGENT_WEB_FETCH_URL_FORBIDDEN")])).toMatchObject({ forbiddenTool: false });
  });
});
