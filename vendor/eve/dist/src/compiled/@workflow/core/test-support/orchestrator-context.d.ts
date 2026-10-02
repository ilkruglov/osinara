import type { Event } from '#compiled/@workflow/world/index.js';
import type { WorkflowOrchestratorContext } from '../private.js';
/**
 * Builds an orchestrator context that replays a hand-written event log through
 * the real workflow primitives (`createUseStep`, `createSleep`,
 * `createCreateHook`), without a World or a VM entrypoint.
 */
export declare function setupWorkflowContext(events: Event[], options?: {
    onDuplicateEvent?: (event: Event) => void;
}): WorkflowOrchestratorContext;
/**
 * Deterministic correlation IDs from the ULID generator with seed 'test', in
 * the order {@link setupWorkflowContext}'s generator mints them.
 */
export declare const CORR_IDS: string[];
/**
 * Runs `workflowFn` against `ctx`, racing it against the context's error
 * channel so a `WorkflowSuspension` or a detected divergence surfaces as
 * `error` rather than hanging.
 */
export declare function runWithDiscontinuation(ctx: WorkflowOrchestratorContext, workflowFn: () => Promise<any>): Promise<{
    result?: any;
    error?: any;
}>;
//# sourceMappingURL=orchestrator-context.d.ts.map