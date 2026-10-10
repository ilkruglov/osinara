/**
 * Turn evidence tests.
 *
 * Constructs covered:
 * - Tool names, loaded skills and step count accumulate per session and turn; failed results
 *   attach to the tool and to the call record, which also carries the hash of the input.
 * - The same input hashes the same way, a different input differently.
 * - The trigger fires on a failed tool, a failed turn, or a heavy turn, never on a quiet one.
 * - The fingerprint is stable for the same tool and code and ignores summary wording then.
 */
import { describe, expect, it } from "vitest";

import {
  createTurnEvidenceCollector,
  improvementFingerprint,
  shouldReflectOnTurn,
} from "./turn-evidence.js";

describe("turn evidence collector", () => {
  it("collects tool calls, failures by call id, and the turn failure", () => {
    const collector = createTurnEvidenceCollector();
    collector.actionsRequested({
      actions: [{ callId: "c1", input: { prompt: "кот" }, kind: "tool-call", toolName: "generate_image" }, { input: { skill: "birthday-card" }, kind: "load-skill" }],
      sessionId: "s", turnId: "t",
    });
    collector.actionsRequested({ actions: [{ callId: "c2", input: { content: "x" }, kind: "tool-call", toolName: "remember" }], sessionId: "s", turnId: "t" });
    collector.actionResult({ callId: "c1", error: { code: "AGENT_IMAGE_PROVIDER_FAILED", message: "  провайдер  упал " }, sessionId: "s", status: "failed", turnId: "t" });
    collector.actionResult({ callId: "c2", sessionId: "s", status: "completed", turnId: "t" });
    collector.turnFailed({ code: "MODEL_CALL_FAILED", message: "x", sessionId: "s", turnId: "t" });

    expect(collector.take("s", "t")).toEqual({
      calls: [
        { code: "AGENT_IMAGE_PROVIDER_FAILED", inputHash: expect.stringMatching(/^[0-9a-f]{16}$/u), toolName: "generate_image" },
        { code: null, inputHash: expect.stringMatching(/^[0-9a-f]{16}$/u), toolName: "remember" },
      ],
      failedTools: [{ code: "AGENT_IMAGE_PROVIDER_FAILED", message: "провайдер упал", toolName: "generate_image" }],
      loadedSkills: ["birthday-card"],
      stepCount: 2,
      toolNames: ["generate_image", "remember"],
      turnFailure: { code: "MODEL_CALL_FAILED", message: "x" },
    });
    expect(collector.take("s", "t")).toBeNull();
  });

  it("knows a turn from its start even when it never calls a tool", () => {
    const collector = createTurnEvidenceCollector();
    expect(collector.take("s", "quiet")).toBeNull();
    collector.turnStarted({ sessionId: "s", turnId: "quiet" });
    expect(collector.take("s", "quiet")).toEqual({ calls: [], failedTools: [], loadedSkills: [], stepCount: 0, toolNames: [], turnFailure: null });
  });

  it("hashes the call input so an unchanged repeat can be told from a changed retry", () => {
    const collector = createTurnEvidenceCollector();
    collector.actionsRequested({ actions: [
      { callId: "a", input: { limit: 10, query: "x" }, kind: "tool-call", toolName: "list_group_history" },
      { callId: "b", input: { query: "x", limit: 10 }, kind: "tool-call", toolName: "list_group_history" },
      { callId: "c", input: { limit: 20, query: "x" }, kind: "tool-call", toolName: "list_group_history" },
    ], sessionId: "s", turnId: "t" });
    const calls = collector.take("s", "t")!.calls;
    expect(calls[0]!.inputHash).toBe(calls[1]!.inputHash);
    expect(calls[0]!.inputHash).not.toBe(calls[2]!.inputHash);
  });

  it("triggers on a failure or a heavy turn only", () => {
    const quiet = { calls: [], failedTools: [], loadedSkills: [], stepCount: 3, toolNames: ["remember"], turnFailure: null };
    expect(shouldReflectOnTurn(quiet)).toBe(false);
    expect(shouldReflectOnTurn({ ...quiet, failedTools: [{ code: "X", message: "", toolName: "bash" }] })).toBe(true);
    expect(shouldReflectOnTurn({ ...quiet, turnFailure: { code: "X", message: "" } })).toBe(true);
    expect(shouldReflectOnTurn({ ...quiet, stepCount: 8 })).toBe(true);
  });

  it("fingerprints by tool and code when known, else by the summary head", () => {
    const a = improvementFingerprint({ category: "tool_error", errorCode: "E1", summary: "Первая формулировка", toolName: "bash" });
    const b = improvementFingerprint({ category: "tool_error", errorCode: "E1", summary: "Совсем другая формулировка", toolName: "bash" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/u);
    const c = improvementFingerprint({ category: "workflow", summary: "Слишком много шагов при поиске!" });
    const d = improvementFingerprint({ category: "workflow", summary: "слишком   много шагов при поиске" });
    expect(c).toBe(d);
    expect(c).not.toBe(a);
  });
});
