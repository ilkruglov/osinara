import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
export type ApplicationRouteMethod = ChannelRouteMethod | "ALL" | "HEAD" | "OPTIONS";
export interface ApplicationChannelRouteRegistration {
    readonly method: ChannelRouteMethod;
    readonly route: string;
    readonly cors?: NormalizedChannelCorsOptions;
}
export interface ApplicationChannelRoute {
    readonly kind: "channel";
    readonly method: ChannelRouteMethod;
    readonly path: string;
    readonly cors?: NormalizedChannelCorsOptions;
}
export interface ApplicationChannelPreflightRoute {
    readonly kind: "channel-preflight";
    readonly method: "OPTIONS";
    readonly path: string;
    readonly cors: NormalizedChannelCorsOptions;
}
export type ApplicationRouteRegistration = ApplicationChannelPreflightRoute | ApplicationChannelRoute | {
    readonly kind: "development-artifacts";
    readonly method: "GET";
    readonly path: string;
} | {
    readonly kind: "development-schedule";
    readonly method: "POST";
    readonly path: string;
} | {
    readonly kind: "health";
    readonly method: "GET" | "HEAD";
    readonly path: string;
} | {
    readonly kind: "home";
    readonly method: "GET";
    readonly path: string;
} | {
    readonly kind: "workflow";
    readonly method: "ALL";
    readonly path: string;
};
export interface ApplicationRouteRegistry {
    /** Active channel bindings after framework override and route deduplication. */
    readonly channelRegistrations: readonly ApplicationChannelRouteRegistration[];
    /** Channel and preflight routes accepted by the application-wide registry. */
    readonly channelRoutes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
    /** Globally deduplicated method/path bindings in Nitro registration order. */
    readonly routes: readonly ApplicationRouteRegistration[];
}
interface ApplicationRouteRegistryHost {
    readonly compileResult: {
        readonly manifest: Pick<CompiledAgentManifest, "channels">;
    };
}
type ApplicationChannelManifestEntry = {
    readonly kind: "channel";
    readonly name: string;
    readonly method: ChannelRouteMethod;
    readonly urlPath: string;
    readonly cors?: NormalizedChannelCorsOptions;
} | {
    readonly kind: "disabled";
    readonly name: string;
};
interface ApplicationFrameworkChannelDefinition {
    readonly name: string;
    readonly method: ChannelRouteMethod;
    readonly urlPath: string;
    readonly cors?: NormalizedChannelCorsOptions;
}
interface MergeApplicationChannelRoutesInput {
    readonly frameworkChannelNames: ReadonlySet<string>;
    readonly frameworkChannels: readonly ApplicationFrameworkChannelDefinition[];
    readonly manifestChannels: readonly ApplicationChannelManifestEntry[];
}
interface CreateApplicationRouteRegistryInput extends MergeApplicationChannelRoutesInput {
    readonly development?: boolean;
}
/** Applies authored-name overrides before deduplicating framework-first route bindings. */
export declare function mergeApplicationChannelRouteRegistrations(input: MergeApplicationChannelRoutesInput): readonly ApplicationChannelRouteRegistration[];
/** Compiles route identity, precedence, and deduplication without importing Nitro. */
export declare function createApplicationRouteRegistryFromInput(input: CreateApplicationRouteRegistryInput): ApplicationRouteRegistry;
export declare function createApplicationRouteRegistry(preparedHost: ApplicationRouteRegistryHost, options?: {
    readonly development?: boolean;
}): ApplicationRouteRegistry;
export declare function computeApplicationChannelRouteRegistrations(preparedHost: ApplicationRouteRegistryHost): readonly ApplicationChannelRouteRegistration[];
export {};
