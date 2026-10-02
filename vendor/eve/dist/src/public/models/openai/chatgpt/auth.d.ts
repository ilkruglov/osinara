export declare function readCodexJwtExpirationMs(token: string | undefined): number | undefined;
export declare function extractCodexAccountIdFromToken(token: string | undefined): string | undefined;
/** Human-readable account label from Codex's JWT, without retaining the token. */
export declare function extractCodexAccountLabelFromToken(token: string | undefined): string | undefined;
