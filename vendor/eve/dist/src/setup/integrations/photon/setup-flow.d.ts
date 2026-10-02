import { appendEnv } from "../../append-env.js";
import type { VercelProjectReference } from "../../project-resolution.js";
import { openUrl } from "../../primitives/open-url.js";
import { deriveSlackConnectorSlug } from "../../scaffold/index.js";
import { writeTextFile } from "../../scaffold/files.js";
import type { SetupApplyContext, SetupPrepareContext } from "../types.js";
import { provisionPhotonConnector } from "./connect.js";
import { findDedicatedPhotonLine, provisionPhotonProject, usePhotonProject } from "./management.js";
export interface PhotonSetupPlan {
    agentName: string;
    credentials: "vercel-connect" | "environment";
    photonProject: "create" | {
        projectId: string;
        projectSecret: string;
    };
    photonProjectName?: string;
    dedicatedLine?: string;
    phoneNumber?: string;
    vercelProject?: VercelProjectReference;
}
export interface PhotonSetupDeps {
    appendEnv: typeof appendEnv;
    deriveConnectorSlug: typeof deriveSlackConnectorSlug;
    findDedicatedLine: typeof findDedicatedPhotonLine;
    openUrl: typeof openUrl;
    provisionConnector: typeof provisionPhotonConnector;
    provisionProject: typeof provisionPhotonProject;
    useProject: typeof usePhotonProject;
    writeTextFile: typeof writeTextFile;
}
export declare function preparePhotonSetup(context: SetupPrepareContext, deps?: PhotonSetupDeps): Promise<PhotonSetupPlan>;
export declare function applyPhotonSetup(plan: PhotonSetupPlan, context: SetupApplyContext, deps?: PhotonSetupDeps): Promise<{
    facts: ({
        label: string;
        value: string;
        kind: "url";
    } | {
        label: string;
        value: string;
        kind: "phone";
    })[];
    deploymentRequired: true;
}>;
