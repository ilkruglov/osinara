import type { RuntimeActionResult } from "#runtime/actions/types.js";
/** Returns results in pending-key order once every requested action has completed. */
export declare function resolveRuntimeActionResultsForKeys<TResult extends RuntimeActionResult>(input: {
    readonly pendingKeys: readonly string[];
    readonly results: readonly TResult[];
}): TResult[] | undefined;
