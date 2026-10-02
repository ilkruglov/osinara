import { McpServer, type McpToolAnnotations, type StandardSchemaWithJSON } from "#compiled/@modelcontextprotocol/server/index.js";
import type { SessionAuthContext } from "#channel/types.js";
export declare const MCP_PROTOCOL_VERSION = "2026-07-28";
export declare const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export interface McpToolDefinition<TInputSchema extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
    readonly name: string;
    readonly description?: string;
    readonly annotations?: McpToolAnnotations;
    readonly inputSchema: TInputSchema;
    readonly outputSchema?: StandardSchemaWithJSON;
}
export interface McpCallToolResult<TStructured extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
    readonly content: readonly McpContent[];
    readonly isError?: boolean;
    readonly structuredContent?: TStructured;
}
export type McpContent = {
    readonly type: "text";
    readonly text: string;
} | {
    readonly type: "resource_link";
    readonly name: string;
    readonly uri: string;
};
export interface McpServerTool {
    readonly name: string;
    register(server: McpServer, auth: SessionAuthContext | null): void;
}
type InferSchemaOutput<TSchema> = TSchema extends StandardSchemaWithJSON<unknown, infer TOutput> ? TOutput : never;
/** Keeps a schema and its inferred handler input coupled while erasing heterogeneous storage. */
export declare function defineMcpTool<const TInputSchema extends StandardSchemaWithJSON<unknown, unknown>, TStructured extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(input: {
    readonly definition: McpToolDefinition<TInputSchema>;
    call(value: InferSchemaOutput<TInputSchema>, context: {
        readonly auth: SessionAuthContext | null;
        readonly signal: AbortSignal;
    }): Promise<McpCallToolResult<TStructured>>;
}): McpServerTool;
export interface McpStreamableHttpServerOptions {
    readonly name: string;
    readonly version: string;
    readonly tools: readonly McpServerTool[];
    authenticate(request: Request): Promise<SessionAuthContext | null | Response>;
}
/**
 * Creates a dual-era, stateless MCP HTTP request handler.
 *
 * Current clients use MCP 2026-07-28's per-request envelope. Older clients
 * fall back to the SDK's stateless 2025 Streamable HTTP implementation.
 */
export declare function createMcpStreamableHttpServer(options: McpStreamableHttpServerOptions): (request: Request) => Promise<Response>;
export {};
