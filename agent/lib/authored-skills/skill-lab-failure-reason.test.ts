/**
 * Why an interrupted lab run did not complete.
 *
 * Constructs covered:
 * - An exhausted call budget is `call_limit`, whether the lab's own code or the call count shows it.
 * - The deadline, cancellation and runner errors keep their own codes; a model or tool failure
 *   surfaces its AGENT_* code; only unknown failures stay `runtime_failed`.
 * - Nothing but AGENT_* identifiers leaves the failure text.
 */
import { describe, expect, it } from "vitest";

import { labFailureReason } from "./skill-lab-runner.js";

const base = { aborted: false, calls: 2, diagnostic: "", failureText: "", maxCalls: 4 };

describe("labFailureReason", () => {
  it("names an exhausted call budget", () => {
    expect(labFailureReason({ ...base, calls: 4 })).toBe("call_limit");
    expect(labFailureReason({ ...base, failureText: '[{"type":"turn.failed","error":"Error: AGENT_SKILL_LAB_CALL_LIMIT"}]' })).toBe("call_limit");
  });

  it("keeps deadline, cancellation and runner codes apart", () => {
    expect(labFailureReason({ ...base, failureText: "Error: AGENT_SKILL_LAB_DEADLINE at reserveCall" })).toBe("deadline");
    expect(labFailureReason({ ...base, aborted: true, calls: 4 })).toBe("cancelled_or_timed_out");
    expect(labFailureReason({ ...base, diagnostic: "AGENT_SKILL_LAB_START_TIMEOUT" })).toBe("AGENT_SKILL_LAB_START_TIMEOUT");
  });

  it("surfaces a model or tool code without the text around it", () => {
    const text = '[{"type":"turn.failed","error":"AGENT_MODEL_REQUEST_REJECTED: провайдер ответил 400, текст меню: сырники"}]';
    expect(labFailureReason({ ...base, failureText: text })).toBe("AGENT_MODEL_REQUEST_REJECTED");
    expect(labFailureReason({ ...base, failureText: "TypeError: cannot read properties" })).toBe("runtime_failed");
  });
});
