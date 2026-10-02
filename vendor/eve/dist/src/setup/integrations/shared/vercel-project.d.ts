import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
export interface IntegrationVercelProjectDeps {
    readProjectLink: typeof readProjectLink;
}
/** Requires the caller to link a Vercel project before integration setup begins applying. */
export declare function resolveIntegrationVercelProject(input: {
    appRoot: string;
    integration: string;
    signal?: AbortSignal;
    deps?: IntegrationVercelProjectDeps;
}): Promise<VercelProjectReference>;
