import { z } from '#compiled/zod/index.js';
import { type SerializedData } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';
export declare const WorkflowRunStatusSchema: z.ZodEnum<{
    pending: "pending";
    running: "running";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
}>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export declare const TerminalWorkflowRunStatusSchema: z.ZodEnum<{
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
}>;
export type TerminalWorkflowRunStatus = z.infer<typeof TerminalWorkflowRunStatusSchema>;
export declare const TERMINAL_WORKFLOW_RUN_STATUSES: ("completed" | "failed" | "cancelled")[];
export declare function isTerminalWorkflowRunStatus(status: string): status is TerminalWorkflowRunStatus;
/**
 * Base schema for the Workflow runs. Prefer using WorkflowRunSchema
 * which implements a discriminatedUnion for various states.
 *
 * Note: input/output use SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
export declare const WorkflowRunBaseSchema: z.ZodObject<{
    runId: z.ZodString;
    status: z.ZodEnum<{
        pending: "pending";
        running: "running";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodOptional<z.ZodNumber>;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    input: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    output: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    error: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    errorCode: z.ZodOptional<z.ZodString>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    encryptionPublicKey: z.ZodOptional<z.ZodString>;
    expiredAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    startedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    completedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    createdAt: z.ZodCoercedDate<unknown>;
    updatedAt: z.ZodCoercedDate<unknown>;
}, z.core.$strip>;
export declare const WorkflowRunSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    runId: z.ZodString;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodOptional<z.ZodNumber>;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    input: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    errorCode: z.ZodOptional<z.ZodString>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    encryptionPublicKey: z.ZodOptional<z.ZodString>;
    expiredAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    startedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    createdAt: z.ZodCoercedDate<unknown>;
    updatedAt: z.ZodCoercedDate<unknown>;
    status: z.ZodEnum<{
        pending: "pending";
        running: "running";
    }>;
    output: z.ZodOptional<z.ZodUndefined>;
    error: z.ZodOptional<z.ZodUndefined>;
    completedAt: z.ZodOptional<z.ZodUndefined>;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodOptional<z.ZodNumber>;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    input: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    errorCode: z.ZodOptional<z.ZodString>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    encryptionPublicKey: z.ZodOptional<z.ZodString>;
    expiredAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    startedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    createdAt: z.ZodCoercedDate<unknown>;
    updatedAt: z.ZodCoercedDate<unknown>;
    status: z.ZodLiteral<"cancelled">;
    output: z.ZodOptional<z.ZodUndefined>;
    error: z.ZodOptional<z.ZodUndefined>;
    completedAt: z.ZodCoercedDate<unknown>;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodOptional<z.ZodNumber>;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    input: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    errorCode: z.ZodOptional<z.ZodString>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    encryptionPublicKey: z.ZodOptional<z.ZodString>;
    expiredAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    startedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    createdAt: z.ZodCoercedDate<unknown>;
    updatedAt: z.ZodCoercedDate<unknown>;
    status: z.ZodLiteral<"completed">;
    output: z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>;
    error: z.ZodOptional<z.ZodUndefined>;
    completedAt: z.ZodCoercedDate<unknown>;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    deploymentId: z.ZodString;
    workflowName: z.ZodString;
    specVersion: z.ZodOptional<z.ZodNumber>;
    executionContext: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    input: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>>;
    errorCode: z.ZodOptional<z.ZodString>;
    attributes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    encryptionPublicKey: z.ZodOptional<z.ZodString>;
    expiredAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    startedAt: z.ZodOptional<z.ZodCoercedDate<unknown>>;
    createdAt: z.ZodCoercedDate<unknown>;
    updatedAt: z.ZodCoercedDate<unknown>;
    status: z.ZodLiteral<"failed">;
    output: z.ZodOptional<z.ZodUndefined>;
    error: z.ZodUnion<readonly [z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>, z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>]>;
    completedAt: z.ZodCoercedDate<unknown>;
}, z.core.$strip>], "status">;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
/** A workflow run with its first start time materialized. */
export type StartedWorkflowRun = WorkflowRun & {
    startedAt: Date;
};
/**
 * WorkflowRun with input/output fields excluded (when resolveData='none').
 * Used for listing runs without fetching the full serialized data.
 */
export type WorkflowRunWithoutData = Omit<WorkflowRun, 'input' | 'output'> & {
    input: undefined;
    output: undefined;
};
export interface CreateWorkflowRunRequest {
    deploymentId: string;
    workflowName: string;
    input: SerializedData;
    executionContext?: SerializedData;
    specVersion?: number;
    /** Plaintext attributes to seed when the run is created. */
    attributes?: Record<string, string>;
}
export interface GetWorkflowRunParams {
    resolveData?: ResolveData;
}
export interface ListWorkflowRunsParams {
    workflowName?: string;
    status?: WorkflowRunStatus;
    pagination?: PaginationOptions;
    resolveData?: ResolveData;
}
export interface CancelWorkflowRunParams {
    resolveData?: ResolveData;
}
/**
 * Maximum number of run IDs that a single bulk cancellation request may
 * carry. Kept small enough that the backend can process one request
 * synchronously without an asynchronous job or cursor.
 */
export declare const BULK_CANCEL_MAX_RUN_IDS = 500;
/**
 * Request payload for cancelling many runs in a single operation.
 *
 * `runIds` must contain 1–{@link BULK_CANCEL_MAX_RUN_IDS} unique IDs.
 * `cancelReason` (max 512 chars) is recorded on each run_cancelled event,
 * mirroring the single-run {@link CancelRunOptions.cancelReason}.
 */
export declare const BulkCancelWorkflowRunsRequestSchema: z.ZodObject<{
    runIds: z.ZodArray<z.ZodString>;
    cancelReason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type BulkCancelWorkflowRunsRequest = z.infer<typeof BulkCancelWorkflowRunsRequestSchema>;
/**
 * Per-run outcome of a bulk cancellation.
 *
 * - `cancelled`: the run was transitioned to cancelled by this request.
 * - `already_cancelled`: the run was already cancelled (idempotent success).
 * - `not_cancellable`: the run is in a terminal, non-cancellable state
 *   (e.g. `completed`/`failed`); `status` reports the observed status.
 * - `not_found`: no run exists for this ID.
 * - `failed`: cancellation failed; `code` is a machine-readable error code
 *   and `retryable` indicates whether retrying may succeed.
 */
export declare const BulkCancelWorkflowRunResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    runId: z.ZodString;
    outcome: z.ZodLiteral<"cancelled">;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    outcome: z.ZodLiteral<"already_cancelled">;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    outcome: z.ZodLiteral<"not_cancellable">;
    status: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    outcome: z.ZodLiteral<"not_found">;
}, z.core.$strip>, z.ZodObject<{
    runId: z.ZodString;
    outcome: z.ZodLiteral<"failed">;
    code: z.ZodString;
    retryable: z.ZodBoolean;
}, z.core.$strip>], "outcome">;
export type BulkCancelWorkflowRunResult = z.infer<typeof BulkCancelWorkflowRunResultSchema>;
/**
 * Aggregate result of a bulk cancellation. `results` preserves the order of
 * the requested `runIds`; `summary` counts each outcome.
 */
export declare const BulkCancelWorkflowRunsResultSchema: z.ZodObject<{
    summary: z.ZodObject<{
        requested: z.ZodNumber;
        cancelled: z.ZodNumber;
        alreadyCancelled: z.ZodNumber;
        notCancellable: z.ZodNumber;
        notFound: z.ZodNumber;
        failed: z.ZodNumber;
    }, z.core.$strip>;
    results: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        runId: z.ZodString;
        outcome: z.ZodLiteral<"cancelled">;
    }, z.core.$strip>, z.ZodObject<{
        runId: z.ZodString;
        outcome: z.ZodLiteral<"already_cancelled">;
    }, z.core.$strip>, z.ZodObject<{
        runId: z.ZodString;
        outcome: z.ZodLiteral<"not_cancellable">;
        status: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        runId: z.ZodString;
        outcome: z.ZodLiteral<"not_found">;
    }, z.core.$strip>, z.ZodObject<{
        runId: z.ZodString;
        outcome: z.ZodLiteral<"failed">;
        code: z.ZodString;
        retryable: z.ZodBoolean;
    }, z.core.$strip>], "outcome">>;
}, z.core.$strip>;
export type BulkCancelWorkflowRunsResult = z.infer<typeof BulkCancelWorkflowRunsResultSchema>;
//# sourceMappingURL=runs.d.ts.map