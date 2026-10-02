/** Narrows one private create-once session token to task-input delivery only. */
export declare function createTaskInputCapabilityToken(operationToken: string): string;
/** Resolves a task-input capability to the create-once session hook it may address. */
export declare function readTaskInputTargetToken(capabilityToken: string): string | undefined;
