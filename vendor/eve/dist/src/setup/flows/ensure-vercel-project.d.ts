import { type LinkProjectDeps } from "../boxes/link-project.js";
import { type ResolveProvisioningDeps } from "../boxes/resolve-provisioning.js";
import type { Prompter } from "../prompter.js";
import { readProjectLink, type VercelProjectReference } from "../project-resolution.js";
import { requireAuth } from "../vercel-project.js";
import { runLoginFlow } from "./login.js";
export interface EnsureVercelProjectDeps {
    resolveProvisioning?: ResolveProvisioningDeps;
    linkProject?: LinkProjectDeps;
    readProjectLink: typeof readProjectLink;
    requireAuth: typeof requireAuth;
    runLoginFlow: typeof runLoginFlow;
}
/** Ensures Vercel authentication and a project link using eve-owned prompts. */
export declare function ensureVercelProject(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
    teamSelectMessage?: (currentTeam: string) => string;
    deps?: Partial<EnsureVercelProjectDeps>;
}): Promise<VercelProjectReference>;
