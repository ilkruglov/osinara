/**
 * Model-facing tool error contract tests.
 *
 * Constructs covered:
 * - `ModelFacingError`: stable structured remediation visible to the model.
 * - `normalizeModelFacingError`: safe conversion of unexpected dependency failures.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "./app-error.js";
import {
  ModelFacingError,
  normalizeModelFacingError,
} from "./model-facing-error.js";

describe("ModelFacingError", () => {
  it("publishes every required correction-loop field in its model-visible message", () => {
    const error = new ModelFacingError({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      correction: "Передайте непустой query.",
      example: { query: "семейная поездка" },
      field: "query",
      reason: "Поле query отсутствует.",
      retryable: true,
      sideEffectStatus: "not_started",
    });

    expect(error.contract).toEqual({
      category: "input",
      code: "AGENT_TOOL_INPUT_INVALID",
      correction: "Передайте непустой query.",
      example: { query: "семейная поездка" },
      field: "query",
      reason: "Поле query отсутствует.",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect(error.message).toContain('"sideEffectStatus":"not_started"');
    expect(error.message).toContain('"retryable":true');
  });

  it("preserves an application error code but never exposes an unknown raw failure", () => {
    const known = normalizeModelFacingError(
      new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена"),
      { toolName: "manage_memory" },
    );
    const unknown = normalizeModelFacingError(
      new Error("connect ECONNREFUSED 10.0.0.4:5432"),
      { toolName: "list_memories" },
    );

    expect(known.contract.code).toBe("AGENT_MEMORY_NOT_FOUND");
    expect(known.contract.correction).toMatch(/list_memories|search_memories/iu);
    expect(unknown.contract.code).toBe("AGENT_TOOL_DEPENDENCY_FAILED");
    expect(unknown.message).not.toContain("10.0.0.4");
    expect(unknown.contract.sideEffectStatus).toBe("unknown");
  });
});
