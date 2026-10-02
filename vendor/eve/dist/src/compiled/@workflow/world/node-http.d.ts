/**
 * A `fetch`-shaped client built on Node's core HTTP modules.
 *
 * `node:http` / `node:https` sit directly on `node:net` / `node:tls`, so a
 * request issued here involves no undici at all: not the adapter's own
 * `Agent`, and not the one behind the runtime's global `fetch`. That is the
 * whole point of this module: it is the transport
 * {@link ./node-http-flag.js | WORKFLOW_NODE_HTTP} selects, for a deployment
 * where undici is not a usable dependency (a bundler that mangles its
 * `node:http2` require, a runtime that ships no working copy of it).
 *
 * The returned value is a platform `Response` built around a streaming body,
 * so every consumer shape the Worlds use keeps working: `text()`, `json()`,
 * `arrayBuffer()`, and reading `body` as a `ReadableStream` / async iterable
 * while the response is still arriving.
 *
 * Node builtins are imported statically here, which is why this module is
 * reached by subpath (`@workflow/world/node-http.js`) and is deliberately not
 * re-exported from the package index: `@workflow/world` is also consumed by
 * browser bundles that must not pull `node:https` into their graph.
 */
import http from 'node:http';
import https from 'node:https';
/**
 * Keep-alive connection pools, one per scheme. Mirrors the role of an undici
 * `Agent`: a caller builds a pair once and hands it to every request that
 * should share its sockets.
 */
export interface NodeHttpAgents {
    http: http.Agent;
    https: https.Agent;
}
export interface NodeHttpAgentOptions {
    /** Max concurrent sockets per origin. Mirrors undici's `connections`. */
    maxSockets: number;
    /** How long an idle socket is kept. Mirrors undici's `keepAliveTimeout`. */
    keepAliveMs: number;
}
/**
 * Build a keep-alive pool pair. Both schemes are created up front because the
 * scheme is a property of each request URL, not of the pool: a local queue
 * delivering to `http://localhost` and a World talking to an `https://` origin
 * both go through {@link nodeHttpFetch}.
 */
export declare function createNodeHttpAgents(options: NodeHttpAgentOptions): NodeHttpAgents;
/** Close both pools and drop their idle sockets. */
export declare function destroyNodeHttpAgents(agents: NodeHttpAgents): void;
export interface NodeHttpFetchInit {
    method?: string;
    headers?: Headers;
    /** Fully-buffered request body. Streaming uploads are not supported. */
    body?: Uint8Array | string | null;
    /** Composed caller/timeout signal. Rejects with `signal.reason`, like `fetch`. */
    signal?: AbortSignal;
    /** Connection pool to dispatch on. Omitted means Node's global agent. */
    agents?: NodeHttpAgents;
    /**
     * Give up if response headers do not arrive within this many ms. `0` or
     * omitted means no deadline, matching undici's `headersTimeout`.
     *
     * Starts when the request is handed a socket, matching where undici starts
     * its own: waiting for a free socket does not consume the budget, connecting
     * does (undici bounds that separately with `connectTimeout`).
     */
    headersTimeoutMs?: number;
    /**
     * Give up after this many ms with no progress on the response body. `0` or
     * omitted means no deadline, matching undici's `bodyTimeout`.
     */
    bodyTimeoutMs?: number;
}
/**
 * Issue one request over Node's core HTTP client and resolve with a platform
 * `Response`.
 *
 * Differences from `fetch` that callers here rely on not mattering: redirects
 * are not followed (every Worlds endpoint answers directly), the request body
 * must be fully buffered, and no cookie or cache handling is applied.
 */
export declare function nodeHttpFetch(url: string, init?: NodeHttpFetchInit): Promise<Response>;
//# sourceMappingURL=node-http.d.ts.map