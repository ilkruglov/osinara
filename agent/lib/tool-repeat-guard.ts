/**
 * Per-turn guard against repeating a tool call that already failed with the same arguments.
 *
 * Exports:
 * - `TOOL_REPEAT_WITHOUT_PROGRESS_CODE`: the stable error code the model sees.
 * - `toolCallFingerprint`: tool name plus a key-sorted JSON of the input.
 * - `createToolRepeatGuard`: bounded in-memory registry of failed fingerprints per turn.
 * - `toolRepeatGuard`: the process-wide instance used by the model-facing boundary.
 *
 * Key construct:
 * - A retry counter cannot see a loop; the fingerprint of "tool + arguments" can. A model that
 *   repeats the exact call after a failure learns nothing new, and one such loop ran a family
 *   member's turn to the 32-step limit. The second identical call is refused before it executes,
 *   with the correction to change the call or report to the person.
 * - A failure that changed the world under the call (a restarted browser) grants one repeat of that
 *   call in the turn: the same `browser_open` can succeed on the fresh browser. A second failure of
 *   the same call blocks it as usual, so a browser that keeps hanging cannot loop the turn.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./json-hash.js";

export const TOOL_REPEAT_WITHOUT_PROGRESS_CODE = "AGENT_TOOL_REPEAT_WITHOUT_PROGRESS";

const MAX_TRACKED_TURNS = 500;

export function toolCallFingerprint(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}\n${canonicalJson(input)}`).digest("hex");
}

export interface ToolRepeatGuard {
  forget(turnKey: string): void;
  /** `freeRetry`: the failure changed the conditions; the first such failure does not block the call. */
  recordFailure(turnKey: string, fingerprint: string, options?: { freeRetry?: boolean }): void;
  recordSuccess(turnKey: string, fingerprint: string): void;
  refuses(turnKey: string, fingerprint: string): boolean;
}

export function createToolRepeatGuard(maxTurns = MAX_TRACKED_TURNS): ToolRepeatGuard {
  const failed = new Map<string, Set<string>>();
  const retried = new Map<string, Set<string>>();
  const turnSet = (registry: Map<string, Set<string>>, turnKey: string): Set<string> => {
    const existing = registry.get(turnKey);
    if (existing) return existing;
    const created = new Set<string>();
    registry.set(turnKey, created);
    // Turns finish without a hook here, so the oldest tracked turns are dropped by insertion order.
    while (registry.size > maxTurns) {
      const oldest = registry.keys().next().value;
      if (oldest === undefined) break;
      registry.delete(oldest);
    }
    return created;
  };

  return {
    forget(turnKey) {
      failed.delete(turnKey);
      retried.delete(turnKey);
    },
    recordFailure(turnKey, fingerprint, options) {
      if (options?.freeRetry) {
        const used = turnSet(retried, turnKey);
        if (!used.has(fingerprint)) {
          used.add(fingerprint);
          return;
        }
      }
      turnSet(failed, turnKey).add(fingerprint);
    },
    recordSuccess(turnKey, fingerprint) {
      failed.get(turnKey)?.delete(fingerprint);
    },
    refuses(turnKey, fingerprint) {
      return failed.get(turnKey)?.has(fingerprint) ?? false;
    },
  };
}

export const toolRepeatGuard = createToolRepeatGuard();
