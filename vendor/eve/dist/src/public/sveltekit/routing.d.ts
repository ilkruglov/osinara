/**
 * Join a route prefix and a path with exactly one separating slash.
 */
export declare function joinRoutePrefix(prefix: string, path: string): string;
/**
 * Reduce an origin string to its canonical `protocol://host[:port]` form.
 */
export declare function normalizeOrigin(origin: string): string;
