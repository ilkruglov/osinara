import { cleanupCreatedConnectionConnector, setupConnectionConnector } from "#setup/connection-connector.js";
import { ensureVercelProject, type EnsureVercelProjectDeps } from "#setup/flows/ensure-vercel-project.js";
import { readProjectLink } from "#setup/project-resolution.js";
import { type Prompter } from "#setup/prompter.js";
import { updateConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";
import type { RegistryCommandLogger } from "./registry.js";
export interface IntegrationConnectOptions {
    nonInteractive?: boolean;
    signal?: AbortSignal;
}
export interface IntegrationConnectDependencies {
    createPrompter?: () => Prompter;
    ensureVercelProject: typeof ensureVercelProject;
    ensureVercelProjectDeps?: Partial<EnsureVercelProjectDeps>;
    readProjectLink: typeof readProjectLink;
    setupConnectionConnector: typeof setupConnectionConnector;
    cleanupCreatedConnectionConnector: typeof cleanupCreatedConnectionConnector;
    updateConnectionConnectorUid: typeof updateConnectionConnectorUid;
}
/** Configures the Vercel Connect connector referenced by an installed connection item. */
export declare function runIntegrationConnect(input: {
    appRoot: string;
    slug: string;
    service: string;
    canonicalConnectorName?: string;
    options?: IntegrationConnectOptions;
    dependencies?: Partial<IntegrationConnectDependencies>;
}): Promise<void>;
/** CLI adapter for the hidden integration command used by trusted registry items. */
export declare function runIntegrationConnectCommand(logger: RegistryCommandLogger, appRoot: string, slug: string, service: string, canonicalConnectorName: string | undefined, options?: IntegrationConnectOptions, dependencies?: IntegrationConnectDependencies): Promise<void>;
