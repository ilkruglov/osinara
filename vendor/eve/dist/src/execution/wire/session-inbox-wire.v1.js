import { z } from "#compiled/zod/index.js";
import {
  inputRequestSchema,
  inputResponseSchema,
} from "#runtime/input/types.js";
import { formatValidationError } from "#runtime/validation.js";
import { jsonObjectSchema, jsonValueSchema } from "#shared/json-schemas.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import { tokenUsageSchema } from "#shared/token-usage.js";
const providerOptionsSchema = z.record(z.string(), jsonObjectSchema),
  textPartSchema = z
    .object({
      providerOptions: providerOptionsSchema.optional(),
      text: z.string(),
      type: z.literal(`text`),
    })
    .strict(),
  binaryDataSchema = z.custom(
    (e) =>
      typeof e == `string` ||
      e instanceof Uint8Array ||
      e instanceof ArrayBuffer ||
      e instanceof URL,
    `Expected a string, URL, Uint8Array, or ArrayBuffer.`,
  ),
  imagePartSchema = z
    .object({
      image: binaryDataSchema,
      mediaType: z.string().optional(),
      providerOptions: providerOptionsSchema.optional(),
      type: z.literal(`image`),
    })
    .strict(),
  filePartSchema = z
    .object({
      data: binaryDataSchema,
      filename: z.string().optional(),
      mediaType: z.string(),
      providerOptions: providerOptionsSchema.optional(),
      type: z.literal(`file`),
    })
    .strict(),
  userContentSchema = z.union([
    z.string(),
    z.array(
      z.discriminatedUnion(`type`, [
        textPartSchema,
        imagePartSchema,
        filePartSchema,
      ]),
    ),
  ]),
  eventCoordinateSchema = z.number().int().nonnegative(),
  opaqueObjectSchema = z.custom(
    (e) => typeof e == `object` && !!e && !Array.isArray(e),
    `Expected an object.`,
  ),
  subagentInputRequestHookPayloadSchema = z
    .object({
      callId: z.string(),
      childContinuationToken: z.string(),
      childSessionId: z.string(),
      event: z
        .object({
          requests: z.array(inputRequestSchema),
          sequence: eventCoordinateSchema,
          stepIndex: eventCoordinateSchema,
          turnId: z.string(),
        })
        .strict(),
      kind: z.literal(`subagent-input-request`),
      subagentName: z.string(),
    })
    .strict(),
  subagentAuthorizationEventHookPayloadSchema = z
    .object({
      callId: z.string(),
      childSessionId: z.string(),
      event: opaqueObjectSchema,
      kind: z.literal(`subagent-authorization-event`),
      subagentName: z.string(),
    })
    .strict(),
  taskMetadataSchema = z
    .object({
      agentId: z.string(),
      kind: z.literal(`subagent`),
      mode: z.enum([`local`, `remote`]),
      name: z.string(),
    })
    .strict(),
  taskViewBase = {
    executor: z
      .object({
        childSessionId: z.string().optional(),
        childTurnId: z.string().optional(),
        lifecycle: z.enum([`parked`, `terminal`]).optional(),
      })
      .strict()
      .optional(),
    metadata: taskMetadataSchema,
    taskId: z.string(),
    usage: tokenUsageSchema.optional(),
  },
  taskViewSchema = z.discriminatedUnion(`status`, [
    z.object({ ...taskViewBase, status: z.literal(`working`) }).strict(),
    z
      .object({
        ...taskViewBase,
        inputRequests: z.array(jsonValueSchema),
        status: z.literal(`input_required`),
      })
      .strict(),
    z
      .object({
        ...taskViewBase,
        lastOutput: z
          .object({ data: jsonValueSchema, type: z.literal(`result`) })
          .strict(),
        status: z.literal(`completed`),
      })
      .strict(),
    z
      .object({
        ...taskViewBase,
        lastOutput: z
          .object({ data: jsonValueSchema, type: z.literal(`error`) })
          .strict(),
        status: z.literal(`failed`),
      })
      .strict(),
    z.object({ ...taskViewBase, status: z.literal(`cancelled`) }).strict(),
  ]),
  taskPayloadSchema = z
    .object({
      authorizationEvents: z
        .array(
          z
            .object({
              hookPayload: subagentAuthorizationEventHookPayloadSchema,
              taskId: z.string(),
            })
            .strict(),
        )
        .optional(),
      inputRequests: z
        .array(
          z
            .object({
              hookPayload: subagentInputRequestHookPayloadSchema,
              taskId: z.string(),
            })
            .strict(),
        )
        .optional(),
      views: z.array(taskViewSchema).optional(),
    })
    .strict(),
  deliverPayloadSchema = z
    .object({
      context: z.array(z.string()).optional(),
      inputResponses: z.array(inputResponseSchema).optional(),
      message: userContentSchema.optional(),
      outputSchema: jsonObjectSchema.optional(),
      task: taskPayloadSchema.optional(),
    })
    .loose(),
  authSchema = z
    .object({
      attributes: z.record(
        z.string(),
        z.union([z.string(), z.array(z.string())]),
      ),
      authenticator: z.string(),
      issuer: z.string().optional(),
      principalId: z.string(),
      principalType: z.string(),
      subject: z.string().optional(),
    })
    .strict(),
  callerSchema = z
    .object({
      callId: z.string(),
      replyTo: z.discriminatedUnion(`kind`, [
        z.object({ kind: z.literal(`hook`), token: z.string() }).strict(),
        z
          .object({
            kind: z.literal(`callback`),
            token: z.string(),
            url: z.string(),
          })
          .strict(),
      ]),
      subagentName: z.string(),
      taskId: z.string().optional(),
    })
    .strict(),
  traceContextSchema = z
    .object({ spanId: z.string(), traceFlags: z.number(), traceId: z.string() })
    .strict(),
  deliveryMetadataSchema = z
    .object({
      channelKind: z.string(),
      channelName: z.string(),
      deliveryId: z.string(),
      payloadIndex: z.number().int().nonnegative(),
      requestId: z.string().optional(),
      requestTraceContext: traceContextSchema.optional(),
    })
    .strict(),
  version = z.literal(1),
  sessionInboxWireV1Schema = z.discriminatedUnion(`kind`, [
    z
      .object({
        auth: authSchema.nullable().optional(),
        caller: callerSchema.optional(),
        deliveryMetadata: z.array(deliveryMetadataSchema).optional(),
        kind: z.literal(`deliver`),
        payload: deliverPayloadSchema.optional(),
        payloads: z.array(deliverPayloadSchema),
        requestId: z.string().optional(),
        taskDeliveryId: z.string().optional(),
        turnPolicy: z.enum([`queue`, `steer`]).optional(),
        version,
      })
      .strict(),
    z.object({ kind: z.literal(`session-timeout`), version }).strict(),
    z.object({ kind: z.literal(`clear`), version }).strict(),
    z.object({ kind: z.literal(`compact`), version }).strict(),
    z
      .object({
        kind: z.literal(`reset`),
        reason: z.string().optional(),
        version,
      })
      .strict(),
    z
      .object({
        kind: z.literal(`cancel`),
        taskId: z.string().optional(),
        turnId: z.string().optional(),
        version,
      })
      .strict(),
  ]);
function encodeSessionCommandV1(e) {
  let t =
      e.kind === `send`
        ? {
            auth: e.auth,
            caller: e.caller,
            deliveryMetadata:
              e.delivery === void 0
                ? void 0
                : [{ ...e.delivery, payloadIndex: 0 }],
            kind: `deliver`,
            payload: e.payload,
            payloads: [e.payload],
            requestId: e.requestId,
            taskDeliveryId: e.taskDeliveryId,
            turnPolicy: e.turnPolicy,
            version: 1,
          }
        : e.kind === `deliver`
          ? { ...e, payload: coalesceDeliverPayloads(e.payloads), version: 1 }
          : { ...e, version: 1 },
    n = sessionInboxWireV1Schema.safeParse(t);
  if (!n.success)
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version 1: ${formatValidationError(n.error)}`,
    );
  return n.data;
}
export { encodeSessionCommandV1, sessionInboxWireV1Schema };
