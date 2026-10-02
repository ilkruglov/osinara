import type { Nitro } from "nitro/types";
import { type ApplicationChannelPreflightRoute, type ApplicationChannelRoute, type ApplicationChannelRouteRegistration } from "#internal/nitro/host/application-route-registry.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
interface ChannelRouteNitro {
    readonly options: Pick<Nitro["options"], "handlers" | "virtual">;
}
/** One active channel binding in the eve-owned application route registry. */
export type NitroChannelRouteRegistration = ApplicationChannelRouteRegistration;
/**
 * Computes the merged set of channel routes the Nitro host should mount.
 */
export declare function computeChannelRouteRegistrations(preparedHost: PreparedApplicationHost): readonly NitroChannelRouteRegistration[];
/**
 * Registers virtual Nitro handlers for the provided eve channel routes.
 */
export declare function registerChannelVirtualHandlers(nitro: Pick<ChannelRouteNitro, "options">, input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly routes: readonly (ApplicationChannelPreflightRoute | ApplicationChannelRoute)[];
}): void;
export {};
