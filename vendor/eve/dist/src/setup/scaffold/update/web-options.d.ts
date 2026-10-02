import { type EvePackageContract } from "../create/project.js";
export type WebAuthentication = "sign-in-with-vercel";
export interface WebPackageVersions {
    evePackage?: EvePackageContract;
    aiPackageVersion?: string;
    betterAuthPackageVersion?: string;
    nextPackageVersion?: string;
    reactPackageVersion?: string;
    reactDomPackageVersion?: string;
    streamdownPackageVersion?: string;
    zodPackageVersion?: string;
    typesReactPackageVersion?: string;
    typesReactDomPackageVersion?: string;
}
export declare function resolveWebPackageVersions(input: WebPackageVersions | undefined, authentication?: WebAuthentication): Required<WebPackageVersions>;
