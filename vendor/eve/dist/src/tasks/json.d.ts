import { z } from "#compiled/zod/index.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskView } from "#tasks/types.js";
/** Model-visible task shape. Unlisted private fields are stripped by zod. */
declare const taskViewJsonSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    metadata: z.ZodObject<{
        agentId: z.ZodString;
        kind: z.ZodLiteral<"subagent">;
        mode: z.ZodEnum<{
            local: "local";
            remote: "remote";
        }>;
        name: z.ZodString;
    }, z.core.$strip>;
    taskId: z.ZodString;
    status: z.ZodLiteral<"working">;
}, z.core.$strip>, z.ZodObject<{
    metadata: z.ZodObject<{
        agentId: z.ZodString;
        kind: z.ZodLiteral<"subagent">;
        mode: z.ZodEnum<{
            local: "local";
            remote: "remote";
        }>;
        name: z.ZodString;
    }, z.core.$strip>;
    taskId: z.ZodString;
    inputRequests: z.ZodReadonly<z.ZodArray<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
    status: z.ZodLiteral<"input_required">;
}, z.core.$strip>, z.ZodObject<{
    metadata: z.ZodObject<{
        agentId: z.ZodString;
        kind: z.ZodLiteral<"subagent">;
        mode: z.ZodEnum<{
            local: "local";
            remote: "remote";
        }>;
        name: z.ZodString;
    }, z.core.$strip>;
    taskId: z.ZodString;
    lastOutput: z.ZodObject<{
        data: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        type: z.ZodLiteral<"result">;
    }, z.core.$strip>;
    status: z.ZodLiteral<"completed">;
}, z.core.$strip>, z.ZodObject<{
    metadata: z.ZodObject<{
        agentId: z.ZodString;
        kind: z.ZodLiteral<"subagent">;
        mode: z.ZodEnum<{
            local: "local";
            remote: "remote";
        }>;
        name: z.ZodString;
    }, z.core.$strip>;
    taskId: z.ZodString;
    lastOutput: z.ZodObject<{
        data: z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>;
        type: z.ZodLiteral<"error">;
    }, z.core.$strip>;
    status: z.ZodLiteral<"failed">;
}, z.core.$strip>, z.ZodObject<{
    metadata: z.ZodObject<{
        agentId: z.ZodString;
        kind: z.ZodLiteral<"subagent">;
        mode: z.ZodEnum<{
            local: "local";
            remote: "remote";
        }>;
        name: z.ZodString;
    }, z.core.$strip>;
    taskId: z.ZodString;
    status: z.ZodLiteral<"cancelled">;
}, z.core.$strip>], "status">;
/**
 * Model-visible task view, inferred from {@link taskViewJsonSchema}.
 *
 * This is the public projection of `TaskView` (#tasks/types.js), not a
 * replacement for it: the durable view additionally carries private
 * `executor` and `usage`, and its module must stay zod-free because it is
 * bundled into workflow bodies.
 */
type TaskViewJson = z.infer<typeof taskViewJsonSchema>;
/** Projects a task view into the JSON value carried by tool results. */
export declare function taskViewToJson(view: TaskView): TaskViewJson;
/** Projects many views into one `{ tasks }` tool output. */
export declare function taskViewsToJson(views: readonly TaskView[]): JsonValue;
export {};
