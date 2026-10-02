/** Environment flag set for processes that belong to an `eve dev` session. */
export declare const EVE_DEV_ENV_FLAG = "EVE_DEV";
/** Reports whether this process belongs to an `eve dev` session. */
export declare function isEveDevEnvironment(): boolean;
/** Environment flag set for a server `eve eval` started to run against. */
export declare const EVE_EVALUATION_ENV_FLAG = "EVE_EVALUATION";
/** Stable identifier for the local eval run this server was started to serve. */
export declare const EVE_EVALUATION_RUN_ID_ENV = "EVE_EVALUATION_RUN_ID";
/**
 * Reports whether this process exists to serve an eval run.
 *
 * False for a server that `eve eval --url` merely points at: that process was
 * started to serve ordinary traffic and cannot know an eval is among it.
 */
export declare function isEveEvaluationEnvironment(): boolean;
export declare function resolveEveEvaluationRunId(): string | undefined;
