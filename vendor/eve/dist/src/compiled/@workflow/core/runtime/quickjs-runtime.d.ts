/**
 * QuickJS WASM workflow VM.
 *
 * An alternative engine for the event-replay execution model: the workflow
 * code runs inside a QuickJS WASM VM (via quickjs-wasi) instead of a
 * `node:vm` context. Every invocation creates a fresh VM, re-executes the
 * workflow function from the top, and replays the recorded event log to
 * resolve awaited primitives — the same replay semantics as the `node:vm`
 * engine.
 *
 * The workflow primitives (useStep, sleep, createHook) are implemented as
 * JavaScript code running inside the QuickJS VM. The host communicates with
 * the VM by evaluating small JS snippets to read pending operations and
 * resolve/reject promises.
 *
 * The VM bootstrap is deliberately split into two phases:
 *   1. Static initialization (`initWorkflowVM`) — run-independent setup:
 *      VM creation and the workflow primitives. (Serialization lives on
 *      the host — see quickjs-serde.ts — so no serde code is evaluated
 *      in the VM.)
 *   2. Per-run initialization (inline in `runQuickJSWorkflow`) — seeded
 *      PRNG/ULID host functions, workflow bundle evaluation, run metadata,
 *      workflow input, and start.
 * Keeping the phases separate is groundwork for VM-memory snapshotting:
 * a follow-up can persist/restore the VM at the phase boundary (e.g. a
 * build-time initial snapshot) without restructuring this module. Note
 * that bundle evaluation currently sits in the per-run phase so that
 * module-scope user code observes the seeded `Math.random`, matching the
 * `node:vm` engine's replay determinism.
 */
import type { Event, RunInput, WorkflowRun, WorldCapabilities } from '#compiled/@workflow/world/index.js';
import { type Snapshot } from '../_quickjs-wasi.js';
import type { DecryptionKey } from '../serialization/encryption.js';
export interface PendingStep {
    type: 'step';
    correlationId: string;
    stepId: string;
    /** Format-prefixed devalue-serialized step input (args + closureVars) */
    input: Uint8Array;
    /** Whether a step_created event already exists for this step */
    hasCreatedEvent: boolean;
}
export interface PendingWait {
    type: 'wait';
    correlationId: string;
    /** ISO string of when to resume */
    resumeAt: string;
    /** Whether a wait_created event already exists for this wait */
    hasCreatedEvent: boolean;
}
export interface PendingHook {
    type: 'hook';
    correlationId: string;
    token: string;
    /** Earliest token reuse time, as milliseconds since the Unix epoch. */
    tokenRetentionUntil?: number;
    isWebhook: boolean;
    metadata?: unknown;
    hasCreatedEvent: boolean;
    /**
     * True for internal system hooks (e.g. AbortController's hook), which
     * are exempt from user-hook token namespace conflict checks.
     */
    isSystem?: boolean;
    /**
     * Set when the workflow called AbortController.abort() during this
     * invocation. The host must record the abort: create a hook_received
     * event carrying `abortPayload` and write/close the abort stream.
     */
    abortRequested?: boolean;
    /** VM-serialized `{ aborted: true, reason }` payload for the abort. */
    abortPayload?: Uint8Array;
    /** Set by the completion drain when a system hook is implicitly disposed. */
    disposed?: boolean;
    /**
     * True when the workflow is awaiting hook.getConflict() for this hook.
     * The entrypoint re-invokes the workflow right after writing
     * hook_created so replay can confirm creation and resolve the awaiter.
     */
    hasGetConflictAwaiter?: boolean;
}
export interface PendingAttribute {
    type: 'attribute';
    correlationId: string;
    /** Normalized attribute changes (plain JSON-able objects) */
    changes: unknown[];
    allowReservedAttributes?: boolean;
    /** Whether an attr_set event already exists for this write */
    hasCreatedEvent: boolean;
}
export interface PendingHookDispose {
    type: 'hook_dispose';
    correlationId: string;
    /**
     * Token of the hook being disposed. Used by the entrypoint to order
     * same-token hook operations sequentially in code order.
     */
    token?: string;
    hasCreatedEvent: boolean;
}
export type PendingOperation = PendingStep | PendingWait | PendingHook | PendingAttribute | PendingHookDispose;
export interface QuickJSRuntimeResult {
    /** The workflow completed — result is format-prefixed devalue bytes */
    completed?: {
        result: Uint8Array;
        /**
         * Leftover pending operations that still need durable side effects at
         * completion: abort recordings, system-hook disposals, fire-and-forget
         * attribute/hook/step events. Mirrors the node:vm engine's
         * drainPendingQueueItems. The entrypoint dispatches these WITHOUT
         * queueing steps or requeuing the run.
         */
        drainOperations?: PendingOperation[];
    };
    /** The workflow suspended with pending operations */
    suspended?: {
        pendingOperations: PendingOperation[];
    };
    /** The workflow failed */
    failed?: {
        message: string;
        stack?: string;
        name?: string;
        /** See completed.drainOperations — same semantics on failure. */
        drainOperations?: PendingOperation[];
        /**
         * Format-prefixed devalue bytes of the original thrown value
         * (Error subclass with cause chain, plain object, primitive, etc.).
         * Set when the VM-side rejection handler successfully serializes
         * the thrown value. The host uses these bytes to reconstruct the
         * original value through the standard error hydration pipeline,
         * preserving type identity (TypeError, FatalError) and non-Error
         * throws verbatim. Falls back to the message/stack/name fields
         * when this is undefined (e.g. extractError pseudo-failures).
         */
        valueBytes?: Uint8Array;
    };
}
export interface QuickJSRuntimeOptions {
    /** The compiled workflow bundle code (workflow mode output from SWC) */
    workflowCode: string;
    /** The workflow ID (e.g. "workflow//./workflows/1_simple//simple") */
    workflowId: string;
    /** The workflow run entity */
    workflowRun: WorkflowRun;
    /** Features supported by the World executing this workflow. */
    worldCapabilities?: WorldCapabilities;
    /**
     * The full event log for the run. Every invocation replays the complete
     * log from the start (same replay semantics as the `node:vm` engine).
     */
    events: Event[];
    /** Encryption key for decrypting event payloads (undefined if unencrypted) */
    encryptionKey?: DecryptionKey;
    /**
     * The local port the workflow server is listening on, used to populate
     * `workflowMetadata.url`. Resolved at call time on the host side so the
     * VM doesn't have to probe the filesystem. Ignored on Vercel — VERCEL_URL
     * takes precedence there.
     */
    port?: number;
    /**
     * Fallback workflow input from the queue message's resilient-start
     * payload. Used when the fetched event log lacks a `run_created` event
     * (eventually-consistent read after the parent's start() wrote it).
     */
    runInput?: RunInput;
}
/**
 * Eval filename used when hydrating the baseline VM. The baseline is
 * shared by EVERY workflow in the bundle, so the filename baked into
 * its compiled code (and therefore into snapshot-path stack frames)
 * must be workflow-independent — hydrating under the first caller's
 * workflowId would break `remapErrorStack`'s filename matching for
 * every other workflow in the bundle. Remap call sites match this
 * constant IN ADDITION to the run's module specifier (which covers
 * fresh-path frames).
 */
export declare const BASELINE_BUNDLE_FILENAME = "workflow-bundle.js";
type BaselineEntry = {
    state: 'ready';
    snapshot: Snapshot;
    /**
     * Raw box pointer of the serde capture root created BEFORE the
     * bundle evaluated (see captureSerdeRoot). The box lives in the
     * snapshot's memory image at this offset; every restored VM
     * re-adopts it so serde initialization executes no guest code
     * after user code has run — capture-before-user-code semantics,
     * identical to the fresh path.
     */
    serdeRootPtr: number;
} | {
    state: 'ineligible';
    reason: string;
};
/** Test-only: reset the baseline cache between test cases. */
export declare function __clearBaselineSnapshotCacheForTests(): void;
/** Test-only: observe how a bundle was classified. */
export declare function __peekBaselineEntryForTests(workflowCode: string): Promise<BaselineEntry | undefined>;
/**
 * A live QuickJS workflow invocation. When the initial `result` is
 * `suspended`, the VM is kept alive so the caller can feed newly recorded
 * events (e.g. terminal events of inline-executed steps) into the SAME VM
 * via `continueWithEvents` — resuming execution exactly where it left off
 * without a fresh-VM re-replay. Terminal results dispose the VM
 * automatically; `dispose()` must be called when abandoning a suspended
 * session (idempotent).
 */
export interface QuickJSWorkflowSession {
    result: QuickJSRuntimeResult;
    /**
     * Process newly recorded events in the live VM and re-evaluate the
     * workflow state. Only valid while the last result was `suspended`.
     * Resets the VM's interrupt budget for the new execution burst.
     */
    continueWithEvents(newEvents: Event[]): Promise<QuickJSRuntimeResult>;
    /** Dispose the VM if it is still alive. Safe to call multiple times. */
    dispose(): void;
}
/**
 * Run a workflow invocation to its first settled state and dispose the
 * VM. Convenience wrapper over {@link startQuickJSWorkflow} for callers
 * (and tests) that don't use live-VM continuation.
 */
export declare function runQuickJSWorkflow(options: QuickJSRuntimeOptions): Promise<QuickJSRuntimeResult>;
export declare function startQuickJSWorkflow(options: QuickJSRuntimeOptions): Promise<QuickJSWorkflowSession>;
export {};
//# sourceMappingURL=quickjs-runtime.d.ts.map