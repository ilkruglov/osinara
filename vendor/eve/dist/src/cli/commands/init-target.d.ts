import type { InitFailurePolicy } from "./init-recovery.js";
export type InitTarget = {
    kind: "existing";
    projectPath: string;
} | {
    createInPlace: boolean;
    failurePolicy: InitFailurePolicy;
    kind: "fresh";
    overwriteExisting: boolean;
    preservedEntries: readonly string[];
    projectName: string;
    projectPath: string;
};
interface ResolveInitTargetInput {
    parentDirectory: string;
    target: string | undefined;
}
/** Classifies the target itself without walking ancestor projects. */
export declare function resolveInitTarget(input: ResolveInitTargetInput): Promise<InitTarget>;
export {};
