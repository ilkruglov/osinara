export type GitInitResult = {
    kind: "initialized";
} | {
    kind: "skipped";
    reason: "existing-metadata" | "git-unavailable" | "parent-repository";
} | {
    kind: "failed";
    repositoryInitialized: boolean;
    reason: string;
    stage: "initialize" | "default-branch" | "stage" | "commit";
};
/**
 * Initializes a Git repository and records the generated files in an initial
 * commit. Missing Git and parent repositories are skips. Repository metadata
 * is retained when a later step fails so eve never destroys useful Git state.
 */
export declare function tryInitializeGit(projectPath: string): Promise<GitInitResult>;
