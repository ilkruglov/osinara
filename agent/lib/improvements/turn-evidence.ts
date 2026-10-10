/**
 * Facts about one Eve turn that may justify an improvement item.
 *
 * Exports:
 * - `TurnEvidence`: tool names, loaded skills, failed tool results, step count, and the turn
 *   failure, if any.
 * - `createTurnEvidenceCollector`: bounded in-memory ledger keyed by session and turn.
 * - `shouldReflectOnTurn`: deterministic trigger (tool error, turn failure, or a heavy turn).
 * - `improvementFingerprint`: stable identity of one recurring problem.
 *
 * Key constructs:
 * - Only application facts are kept: tool names and the codes/messages of our own errors. No
 *   message text from people ever enters the evidence, so chat content cannot steer reflection.
 * - The ledger is bounded like the skill-signal counter: a restart loses at most the live turn.
 */
import { createHash } from "node:crypto";

import { clipText } from "../display-text.js";
import { canonicalJson } from "../json-hash.js";
import type { TurnToolCall } from "../turn-quality/turn-process-metrics.js";

const REFLECTION_STEP_THRESHOLD = 8;
const MAX_TRACKED_TURNS = 200;
const ERROR_MESSAGE_MAX_CHARACTERS = 300;

export interface TurnToolFailure {
  code: string;
  message: string;
  toolName: string;
}

export interface TurnEvidence {
  /** Every tool call in order, with the hash of its input and its failure code, for the process metrics. */
  calls: TurnToolCall[];
  failedTools: TurnToolFailure[];
  /** Names passed to `load_skill` this turn, in order; static and authored skills alike. */
  loadedSkills: string[];
  stepCount: number;
  toolNames: string[];
  turnFailure: { code: string; message: string } | null;
}

/** `skill` is written by the application only (a loaded authored skill in a failed or heavy turn). */
export type ImprovementCategory = "memory" | "other" | "prompt" | "skill" | "tool_error" | "workflow";

function emptyEvidence(): TurnEvidence {
  return { calls: [], failedTools: [], loadedSkills: [], stepCount: 0, toolNames: [], turnFailure: null };
}

/** Short stable hash of a call's input: the identity of a repeat, never stored as text. */
function inputHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input ?? null)).digest("hex").slice(0, 16);
}

function clip(text: string): string {
  return clipText(text.replace(/\s+/gu, " ").trim(), ERROR_MESSAGE_MAX_CHARACTERS);
}

export function createTurnEvidenceCollector() {
  const turns = new Map<string, TurnEvidence>();
  const callTools = new Map<string, string>();
  const callRecords = new Map<string, TurnToolCall>();

  function key(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  function evidenceFor(turnKey: string): TurnEvidence {
    const existing = turns.get(turnKey);
    if (existing) {
      // Re-insert so the most recently touched turn is evicted last.
      turns.delete(turnKey);
      turns.set(turnKey, existing);
      return existing;
    }
    const created = emptyEvidence();
    turns.set(turnKey, created);
    while (turns.size > MAX_TRACKED_TURNS) {
      const oldest = turns.keys().next().value;
      if (oldest === undefined) break;
      turns.delete(oldest);
    }
    return created;
  }

  return {
    /** A turn exists from its start, so a turn that never calls a tool is still evaluated. */
    turnStarted(input: { sessionId: string; turnId: string }): void {
      evidenceFor(key(input.sessionId, input.turnId));
    },

    actionsRequested(input: {
      actions: readonly { callId?: string; input?: unknown; kind: string; toolName?: string }[];
      sessionId: string;
      turnId: string;
    }): void {
      const evidence = evidenceFor(key(input.sessionId, input.turnId));
      evidence.stepCount += 1;
      for (const action of input.actions) {
        if (action.kind === "load-skill") {
          const skill = (action.input as { skill?: unknown } | undefined)?.skill;
          if (typeof skill === "string" && skill.length > 0) evidence.loadedSkills.push(skill);
          continue;
        }
        if (action.kind !== "tool-call" || typeof action.toolName !== "string") continue;
        evidence.toolNames.push(action.toolName);
        const call: TurnToolCall = { code: null, inputHash: inputHash(action.input), toolName: action.toolName };
        evidence.calls.push(call);
        if (typeof action.callId === "string") {
          callTools.set(`${input.sessionId}:${action.callId}`, action.toolName);
          callRecords.set(`${input.sessionId}:${action.callId}`, call);
          while (callTools.size > MAX_TRACKED_TURNS * 8) {
            const oldest = callTools.keys().next().value;
            if (oldest === undefined) break;
            callTools.delete(oldest);
            callRecords.delete(oldest);
          }
        }
      }
    },

    actionResult(input: {
      callId?: string;
      error?: { code: string; message: string };
      sessionId: string;
      status: "completed" | "failed" | "rejected";
      toolName?: string;
      turnId: string;
    }): void {
      if (input.status !== "failed") return;
      const evidence = evidenceFor(key(input.sessionId, input.turnId));
      const toolName = input.toolName ??
        (typeof input.callId === "string" ? callTools.get(`${input.sessionId}:${input.callId}`) : undefined) ??
        "unknown";
      const code = input.error?.code ?? "UNKNOWN";
      evidence.failedTools.push({ code, message: clip(input.error?.message ?? ""), toolName });
      const record = typeof input.callId === "string" ? callRecords.get(`${input.sessionId}:${input.callId}`) : undefined;
      if (record) record.code = code;
    },

    turnFailed(input: { code: string; message: string; sessionId: string; turnId: string }): void {
      const evidence = evidenceFor(key(input.sessionId, input.turnId));
      evidence.turnFailure = { code: input.code, message: clip(input.message) };
    },

    /** Removes and returns the turn's evidence; a turn without any recorded event yields null. */
    take(sessionId: string, turnId: string): TurnEvidence | null {
      const turnKey = key(sessionId, turnId);
      const evidence = turns.get(turnKey) ?? null;
      turns.delete(turnKey);
      return evidence;
    },
  };
}

export function shouldReflectOnTurn(evidence: TurnEvidence): boolean {
  return evidence.failedTools.length > 0 ||
    evidence.turnFailure !== null ||
    evidence.stepCount >= REFLECTION_STEP_THRESHOLD;
}

function normalizeSummary(summary: string): string {
  return summary
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

/** Category plus tool and error code when the evidence names them, else the summary's head. */
export function improvementFingerprint(input: {
  category: ImprovementCategory;
  errorCode?: string | null;
  summary: string;
  toolName?: string | null;
}): string {
  const key = input.errorCode
    ? `${input.category}|${input.toolName ?? ""}|${input.errorCode}`
    : `${input.category}|${normalizeSummary(input.summary)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
