export { isAuthoredSourcePath } from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";
export declare const DEV_RUNTIME_SOURCE_DIRECTORY = "source";
export declare class DevelopmentRuntimeSourceSnapshotError extends Error {
    constructor(message: string);
}
export interface DevelopmentSourceSnapshotPlan {
    readonly appRoot: string;
    readonly copyFiles: readonly string[];
    readonly dependencyMounts: readonly DevelopmentSourceSnapshotDependencyMount[];
    readonly runtimeAppRoot: string;
    readonly snapshotRoot: string;
    readonly snapshotSourceRoot: string;
    readonly sourceRoot: string;
    readonly tsconfigPaths: readonly string[];
    readonly watchPaths: readonly string[];
}
export interface DevelopmentSourceSnapshotDependencyMount {
    readonly mountPath: string;
    readonly sourceKind: "installed" | "workspace";
    readonly sourcePath: string;
}
export declare function createDevelopmentSourceSnapshotPlan(input: {
    readonly appRoot: string;
    /**
     * Workspace roots that host extension-authored source. Their dependency and
     * tsconfig topology participates in watch and mount discovery before the
     * authored module graph is materialized.
     */
    readonly authoredSourceRoots?: readonly string[];
    readonly snapshotRoot: string;
}): Promise<DevelopmentSourceSnapshotPlan>;
export declare function resolveDevelopmentSourceSnapshotWatchPaths(appRoot: string): Promise<string[]>;
export declare function toDevelopmentSourceSnapshotPath(input: {
    readonly snapshotSourceRoot: string;
    readonly sourcePath: string;
    readonly sourceRoot: string;
}): string;
/** Resolves the repository/workspace boundary used for authored development sources. */
export declare function resolveDevelopmentSourceRoot(appRoot: string): string;
