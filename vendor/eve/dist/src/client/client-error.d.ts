/**
 * Error thrown when the eve server returns a non-successful HTTP response.
 */
export declare class ClientError extends Error {
    /** Stable eve error code when the response body provides one. */
    readonly code: string | undefined;
    /**
     * HTTP status code returned by the server.
     */
    readonly status: number;
    /**
     * Raw response body text.
     */
    readonly body: string;
    /**
     * Response headers, normalized to lowercase names.
     */
    readonly headers: Readonly<Record<string, string>>;
    constructor(status: number, body: string, headers?: ConstructorParameters<typeof Headers>[0]);
}
