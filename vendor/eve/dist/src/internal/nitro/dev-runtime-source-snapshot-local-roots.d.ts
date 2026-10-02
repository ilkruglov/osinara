/**
 * Resolves the local roots that a tsconfig's path aliases can resolve to.
 * Each alias target that lands on authored workspace source contributes the
 * owning package root (or the target directory itself when no package owns
 * it), so snapshot planning can copy the aliased source.
 */
export declare function resolveLocalTsConfigPathTargetRoots(input: {
    readonly configPath: string;
    readonly sourceRoot: string;
}): Promise<string[]>;
/** Resolves the nearest ancestor directory (bounded by the source root) that owns a package.json. */
export declare function resolveNearestPackageRoot(path: string, sourceRoot: string): Promise<string | undefined>;
/** Returns whether a path is authored workspace source rather than installed dependency data. */
export declare function isAuthoredSourcePath(path: string, sourceRoot: string): boolean;
export declare function isPathInsideOrEqual(path: string, directory: string): boolean;
