/**
 * Builds a fetchable URL from a caller-provided host and an eve route path.
 *
 * `host` may be an absolute origin (`https://agent.example.com`) or a
 * same-origin prefix (`/api`). Prefixes are important for browser clients that
 * talk to an app-owned proxy instead of the eve deployment directly.
 *
 * `routePath` may carry its own query string (`/path?a=1`); it is split off
 * before path joining — assigning it through `URL.pathname` would percent-
 * encode the `?` into the final path segment. Explicit `searchParams` win
 * over same-named embedded query params.
 */
export declare function createClientUrl(host: string, routePath: string, searchParams?: Readonly<Record<string, string>>): string;
