import type { Plugin } from "vite";
/**
 * Options for the eve SvelteKit Vite plugin.
 */
export interface EveSvelteKitPluginOptions {
    /**
     * Path to the eve application root, relative to the SvelteKit project root
     * unless absolute. Defaults to the SvelteKit project root.
     */
    readonly eveRoot?: string;
    /**
     * Command that builds the eve app inside the generated Vercel eve service.
     * Defaults to running the installed eve binary from the SvelteKit app's
     * dependencies (`node <path-to>/eve/bin/eve.js build`).
     */
    readonly eveBuildCommand?: string;
}
/**
 * Vite plugin for running an eve agent alongside a SvelteKit app.
 *
 * In development and local preview, `eveSvelteKit` proxies eve protocol
 * endpoints to a local eve server. It resolves the server in order: the
 * `EVE_BASE_URL` env var if set, then a healthy shared eve dev server already
 * running for the app, then a freshly spawned `eve dev --no-ui --port 0`.
 *
 * On Vercel builds, `eveSvelteKit` adds the eve runtime as a sibling Vercel
 * service and routes its transport requests before SvelteKit filesystem
 * routing.
 */
export declare function eveSvelteKit(options?: EveSvelteKitPluginOptions): Plugin;
