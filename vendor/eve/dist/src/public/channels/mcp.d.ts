import { type Channel } from "#public/definitions/channel.js";
import { type AuthFn } from "#public/channels/auth.js";
export interface McpChannelInput {
    /** Existing eve route-auth policy. Use `none()` for explicit public access. */
    readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
    /** Override the default MCP route path (`/eve/v1/mcp`). */
    readonly route?: string;
}
/** Public MCP channel exposing durable agent invocation compatibility tools. */
export type McpChannel = Channel;
/**
 * Publishes this agent as a stateless Streamable HTTP MCP server.
 *
 * This channel owns only MCP transport and durable eve invocation. It reuses
 * eve's inbound auth strategies and recognizes `oauthResource(...)` metadata
 * when OAuth discovery is needed.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export declare function mcpChannel(input: McpChannelInput): McpChannel;
