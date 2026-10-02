export type InitFailurePolicy = "clear" | "preserve" | "remove";
export declare function cleanupFreshInitTarget(projectPath: string, policy: Exclude<InitFailurePolicy, "preserve">, preservedEntries?: readonly string[]): Promise<boolean>;
export declare function workspaceFailureNote(workspaceMember: boolean): string;
