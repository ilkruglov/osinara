import type { InputRequest } from "#runtime/input/types.js";
/** Label prefixing the framework-injected pending-approval notice. */
export declare const PENDING_APPROVALS_LABEL = "[Pending approvals]";
/** True when text is the framework-injected pending-approval notice. */
export declare function isPendingApprovalsSnippet(text: string): boolean;
/**
 * Renders the durable, model-visible projection of unresolved tool approvals.
 * The harness appends it when the batch is created, so later wakeups reuse the
 * same history prefix instead of regenerating the notice.
 */
export declare function renderPendingApprovalsSnippet(requests: readonly InputRequest[]): string | undefined;
