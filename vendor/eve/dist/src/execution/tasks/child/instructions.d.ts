export declare const TASK_UPDATE_SESSION_INSTRUCTION = "Background task updates\nYou are running as a background task. For multi-step work, use `task_update` at meaningful milestones to briefly state what you are currently doing. Keep updates terse and activity-focused; do not include preliminary findings or results. Do not wait for a response, and return your final result normally.";
/** True when the serialized caller binding points at a durable task inbox. */
export declare function isTaskOwnedSerializedContext(serializedContext: Record<string, unknown>): boolean;
