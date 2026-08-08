/**
 * Deterministic memory-thread discovery gates.
 *
 * Exports:
 * - `evaluateImmediateThreadGate`: proves one evidenced claim has explicit future continuation.
 * - `evaluateRecoveryThreadGate`: enforces the named 3/2/90 same-identity recovery boundary.
 * - `validateSubthreadEvidence`: requires repeated episodes plus an independent long-term axis.
 */
import {
  THREAD_DISCOVERY_LOOKBACK_DAYS,
  THREAD_DISCOVERY_MIN_CLAIMS,
  THREAD_DISCOVERY_MIN_SOURCE_BATCHES,
} from "./memory-config.js";

interface GateResult {
  eligible: boolean;
  reason?: string;
}

export interface ThreadRecoveryClaim {
  batchRef: string;
  evidenced: boolean;
  observedAt: string;
  projectRef: string | null;
  scope: "family" | "group" | "personal";
  sourceRef: string;
  subjectRef: string | null;
}

export type ThreadEntryRole =
  | "constraint"
  | "decision"
  | "episode"
  | "goal"
  | "lesson"
  | "method"
  | "open_loop"
  | "outcome";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const SUBTHREAD_LONG_TERM_ROLES = new Set<ThreadEntryRole>([
  "goal", "method", "outcome", "open_loop",
]);

export function evaluateImmediateThreadGate(input: {
  evidenced: boolean;
  ongoingFutureWork: boolean;
}): GateResult {
  if (!input.evidenced) return { eligible: false, reason: "source_not_evidenced" };
  if (!input.ongoingFutureWork) return { eligible: false, reason: "future_work_not_explicit" };
  return { eligible: true };
}

export function evaluateRecoveryThreadGate(
  claims: readonly ThreadRecoveryClaim[],
  now: Date,
): GateResult {
  if (claims.length < THREAD_DISCOVERY_MIN_CLAIMS) {
    return { eligible: false, reason: "insufficient_claims" };
  }
  if (claims.some((claim) => !claim.evidenced)) {
    return { eligible: false, reason: "source_not_evidenced" };
  }

  // A cluster has exactly one identity axis. A project replaces, rather than supplements, a subject.
  const identities = new Set(claims.map((claim) => {
    const identity = claim.subjectRef === null
      ? claim.projectRef === null
        ? claim.scope === "family" || claim.scope === "group" ? "project:pending" : "invalid"
        : `project:${claim.projectRef}`
      : claim.projectRef === null ? `subject:${claim.subjectRef}` : "invalid";
    return `${claim.scope}:${identity}`;
  }));
  if (identities.size !== 1 || [...identities][0]?.endsWith(":invalid")) {
    return { eligible: false, reason: "identity_mismatch" };
  }

  const cutoff = now.getTime() - THREAD_DISCOVERY_LOOKBACK_DAYS * DAY_MILLISECONDS;
  if (claims.some((claim) => {
    const observed = Date.parse(claim.observedAt);
    return !Number.isFinite(observed) || observed < cutoff || observed > now.getTime();
  })) {
    return { eligible: false, reason: "outside_lookback" };
  }
  if (new Set(claims.map((claim) => claim.batchRef)).size < THREAD_DISCOVERY_MIN_SOURCE_BATCHES) {
    return { eligible: false, reason: "insufficient_source_batches" };
  }
  return { eligible: true };
}

export function validateSubthreadEvidence(
  entries: readonly {
    batchRef: string | null;
    role: ThreadEntryRole;
    sourceKind: "episode" | "fact" | "family_shared" | "preference" | "profile";
  }[],
): GateResult {
  const episodes = entries.filter((entry) =>
    entry.role === "episode" && entry.sourceKind === "episode" && entry.batchRef !== null
  );
  if (episodes.length < 2 || new Set(episodes.map((entry) => entry.batchRef)).size < 2) {
    return { eligible: false, reason: "repeated_episodes_missing" };
  }
  if (!entries.some((entry) => SUBTHREAD_LONG_TERM_ROLES.has(entry.role))) {
    return { eligible: false, reason: "independent_long_term_axis_missing" };
  }
  return { eligible: true };
}
