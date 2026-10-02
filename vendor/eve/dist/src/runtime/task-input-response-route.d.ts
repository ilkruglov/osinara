import type { RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
export declare function getTaskInputResponseChannelDefinitions(): readonly ResolvedChannelDefinition[];
export declare function getTaskInputResponseChannelNames(): ReadonlySet<string>;
export declare function handleTaskInputResponseRequest(request: Request, ctx: RouteContext): Promise<Response>;
