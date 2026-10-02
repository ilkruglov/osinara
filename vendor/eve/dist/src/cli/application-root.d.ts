import { resolveDiscoveryProject, type ResolvedDiscoveryProject } from "#discover/project.js";
export interface ResolveCliApplicationRootDependencies {
    readonly resolveDiscoveryProject: typeof resolveDiscoveryProject;
}
/** Resolves the nearest enclosing eve application and agent roots. */
export declare function resolveCliApplicationProject(cwd?: string, dependencies?: ResolveCliApplicationRootDependencies): Promise<ResolvedDiscoveryProject>;
/** Finds the nearest enclosing eve application. */
export declare function findCliApplicationRoot(cwd?: string, dependencies?: ResolveCliApplicationRootDependencies): Promise<string | undefined>;
/** Uses the nearest enclosing eve application, or preserves cwd when none exists. */
export declare function resolveCliApplicationRoot(cwd?: string, dependencies?: ResolveCliApplicationRootDependencies): Promise<string>;
