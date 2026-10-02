import { z } from "#compiled/zod/index.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
const taskMetadataJsonSchema = z.object({
    agentId: z.string(),
    kind: z.literal(`subagent`),
    mode: z.enum([`local`, `remote`]),
    name: z.string(),
  }),
  taskOutputJsonSchema = z.object({
    data: jsonValueSchema,
    type: z.enum([`result`, `error`]),
  }),
  taskViewJsonBaseShape = {
    metadata: taskMetadataJsonSchema,
    taskId: z.string(),
  },
  taskViewJsonSchema = z.discriminatedUnion(`status`, [
    z.object({ ...taskViewJsonBaseShape, status: z.literal(`working`) }),
    z.object({
      ...taskViewJsonBaseShape,
      inputRequests: z.array(jsonValueSchema).readonly(),
      status: z.literal(`input_required`),
    }),
    z.object({
      ...taskViewJsonBaseShape,
      lastOutput: taskOutputJsonSchema.extend({ type: z.literal(`result`) }),
      status: z.literal(`completed`),
    }),
    z.object({
      ...taskViewJsonBaseShape,
      lastOutput: taskOutputJsonSchema.extend({ type: z.literal(`error`) }),
      status: z.literal(`failed`),
    }),
    z.object({ ...taskViewJsonBaseShape, status: z.literal(`cancelled`) }),
  ]);
function taskViewToJson(e) {
  return taskViewJsonSchema.parse(e);
}
function taskViewsToJson(e) {
  return { tasks: e.map((e) => taskViewToJson(e)) };
}
export { taskViewToJson, taskViewsToJson };
