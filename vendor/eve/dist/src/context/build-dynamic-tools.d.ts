import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { ContextReader } from "#context/key.js";
/**
 * Builds live dynamic tool definitions. Narrower scopes appear first
 * so they win on name collision (the tool-loop uses `??=` for dedup).
 *
 * Step tools are live closures (re-resolved every step via
 * `LiveStepToolsKey`). Session and turn tools replay durable metadata.
 */
export declare function buildResponseAuthorizationTools(input: {
    readonly authoredTools: HarnessToolMap;
    readonly context?: ContextReader;
}): HarnessToolMap;
export declare function buildDynamicTools(ctx: ContextReader): readonly HarnessToolDefinition[];
