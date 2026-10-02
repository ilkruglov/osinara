export interface McpProtectedResourceMetadataOptions {
    readonly authorizationServers: readonly string[];
    readonly resource: string;
    readonly scopesSupported?: readonly string[];
}
/** Creates RFC 9728 protected-resource metadata for an MCP endpoint. */
export declare function createMcpProtectedResourceMetadata(options: McpProtectedResourceMetadataOptions): Readonly<Record<string, unknown>>;
/** Creates the RFC 9728 bearer discovery challenge for an MCP resource. */
export declare function createMcpResourceChallenge(resourceMetadataUrl: string, scopes?: readonly string[]): string;
