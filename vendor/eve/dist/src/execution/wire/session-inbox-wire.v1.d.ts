import type { DataContent } from "ai";
import { z } from "#compiled/zod/index.js";
import type { DeliverHookPayload, SessionCommand, SessionTimeoutHookPayload } from "#channel/types.js";
import type { TaskView } from "#tasks/types.js";
/** The complete schema for persisted session-inbox wire version 1. */
export declare const sessionInboxWireV1Schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    auth: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        attributes: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        authenticator: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
        principalId: z.ZodString;
        principalType: z.ZodString;
        subject: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    caller: z.ZodOptional<z.ZodObject<{
        callId: z.ZodString;
        replyTo: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"hook">;
            token: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"callback">;
            token: z.ZodString;
            url: z.ZodString;
        }, z.core.$strict>], "kind">;
        subagentName: z.ZodString;
        taskId: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    deliveryMetadata: z.ZodOptional<z.ZodArray<z.ZodObject<{
        channelKind: z.ZodString;
        channelName: z.ZodString;
        deliveryId: z.ZodString;
        payloadIndex: z.ZodNumber;
        requestId: z.ZodOptional<z.ZodString>;
        requestTraceContext: z.ZodOptional<z.ZodObject<{
            spanId: z.ZodString;
            traceFlags: z.ZodNumber;
            traceId: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    kind: z.ZodLiteral<"deliver">;
    payload: z.ZodOptional<z.ZodObject<{
        context: z.ZodOptional<z.ZodArray<z.ZodString>>;
        inputResponses: z.ZodOptional<z.ZodArray<z.ZodObject<{
            optionId: z.ZodOptional<z.ZodString>;
            requestId: z.ZodString;
            text: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        message: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            text: z.ZodString;
            type: z.ZodLiteral<"text">;
        }, z.core.$strict>, z.ZodObject<{
            image: z.ZodCustom<URL | DataContent, URL | DataContent>;
            mediaType: z.ZodOptional<z.ZodString>;
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            type: z.ZodLiteral<"image">;
        }, z.core.$strict>, z.ZodObject<{
            data: z.ZodCustom<URL | DataContent, URL | DataContent>;
            filename: z.ZodOptional<z.ZodString>;
            mediaType: z.ZodString;
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            type: z.ZodLiteral<"file">;
        }, z.core.$strict>], "type">>]>>;
        outputSchema: z.ZodOptional<z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>;
        task: z.ZodOptional<z.ZodObject<{
            authorizationEvents: z.ZodOptional<z.ZodArray<z.ZodObject<{
                hookPayload: z.ZodObject<{
                    callId: z.ZodString;
                    childSessionId: z.ZodString;
                    event: z.ZodCustom<Record<string, unknown>, Record<string, unknown>>;
                    kind: z.ZodLiteral<"subagent-authorization-event">;
                    subagentName: z.ZodString;
                }, z.core.$strict>;
                taskId: z.ZodString;
            }, z.core.$strict>>>;
            inputRequests: z.ZodOptional<z.ZodArray<z.ZodObject<{
                hookPayload: z.ZodObject<{
                    callId: z.ZodString;
                    childContinuationToken: z.ZodString;
                    childSessionId: z.ZodString;
                    event: z.ZodObject<{
                        requests: z.ZodArray<z.ZodObject<{
                            action: z.ZodObject<{
                                callId: z.ZodString;
                                input: z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>;
                                kind: z.ZodLiteral<"tool-call">;
                                toolName: z.ZodString;
                            }, z.core.$strict>;
                            allowFreeform: z.ZodOptional<z.ZodBoolean>;
                            display: z.ZodOptional<z.ZodEnum<{
                                confirmation: "confirmation";
                                select: "select";
                                text: "text";
                            }>>;
                            kind: z.ZodEnum<{
                                question: "question";
                                "session-limit": "session-limit";
                                "tool-approval": "tool-approval";
                            }>;
                            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                                description: z.ZodOptional<z.ZodString>;
                                id: z.ZodString;
                                label: z.ZodString;
                                style: z.ZodOptional<z.ZodEnum<{
                                    danger: "danger";
                                    default: "default";
                                    primary: "primary";
                                }>>;
                            }, z.core.$strict>>>;
                            prompt: z.ZodString;
                            requestId: z.ZodString;
                        }, z.core.$strict>>;
                        sequence: z.ZodNumber;
                        stepIndex: z.ZodNumber;
                        turnId: z.ZodString;
                    }, z.core.$strict>;
                    kind: z.ZodLiteral<"subagent-input-request">;
                    subagentName: z.ZodString;
                }, z.core.$strict>;
                taskId: z.ZodString;
            }, z.core.$strict>>>;
            views: z.ZodOptional<z.ZodArray<z.ZodType<TaskView, unknown, z.core.$ZodTypeInternals<TaskView, unknown>>>>;
        }, z.core.$strict>>;
    }, z.core.$loose>>;
    payloads: z.ZodArray<z.ZodObject<{
        context: z.ZodOptional<z.ZodArray<z.ZodString>>;
        inputResponses: z.ZodOptional<z.ZodArray<z.ZodObject<{
            optionId: z.ZodOptional<z.ZodString>;
            requestId: z.ZodString;
            text: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        message: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            text: z.ZodString;
            type: z.ZodLiteral<"text">;
        }, z.core.$strict>, z.ZodObject<{
            image: z.ZodCustom<URL | DataContent, URL | DataContent>;
            mediaType: z.ZodOptional<z.ZodString>;
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            type: z.ZodLiteral<"image">;
        }, z.core.$strict>, z.ZodObject<{
            data: z.ZodCustom<URL | DataContent, URL | DataContent>;
            filename: z.ZodOptional<z.ZodString>;
            mediaType: z.ZodString;
            providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>>;
            type: z.ZodLiteral<"file">;
        }, z.core.$strict>], "type">>]>>;
        outputSchema: z.ZodOptional<z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>>;
        task: z.ZodOptional<z.ZodObject<{
            authorizationEvents: z.ZodOptional<z.ZodArray<z.ZodObject<{
                hookPayload: z.ZodObject<{
                    callId: z.ZodString;
                    childSessionId: z.ZodString;
                    event: z.ZodCustom<Record<string, unknown>, Record<string, unknown>>;
                    kind: z.ZodLiteral<"subagent-authorization-event">;
                    subagentName: z.ZodString;
                }, z.core.$strict>;
                taskId: z.ZodString;
            }, z.core.$strict>>>;
            inputRequests: z.ZodOptional<z.ZodArray<z.ZodObject<{
                hookPayload: z.ZodObject<{
                    callId: z.ZodString;
                    childContinuationToken: z.ZodString;
                    childSessionId: z.ZodString;
                    event: z.ZodObject<{
                        requests: z.ZodArray<z.ZodObject<{
                            action: z.ZodObject<{
                                callId: z.ZodString;
                                input: z.ZodType<import("../../shared/json.ts").JsonObject, unknown, z.core.$ZodTypeInternals<import("../../shared/json.ts").JsonObject, unknown>>;
                                kind: z.ZodLiteral<"tool-call">;
                                toolName: z.ZodString;
                            }, z.core.$strict>;
                            allowFreeform: z.ZodOptional<z.ZodBoolean>;
                            display: z.ZodOptional<z.ZodEnum<{
                                confirmation: "confirmation";
                                select: "select";
                                text: "text";
                            }>>;
                            kind: z.ZodEnum<{
                                question: "question";
                                "session-limit": "session-limit";
                                "tool-approval": "tool-approval";
                            }>;
                            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                                description: z.ZodOptional<z.ZodString>;
                                id: z.ZodString;
                                label: z.ZodString;
                                style: z.ZodOptional<z.ZodEnum<{
                                    danger: "danger";
                                    default: "default";
                                    primary: "primary";
                                }>>;
                            }, z.core.$strict>>>;
                            prompt: z.ZodString;
                            requestId: z.ZodString;
                        }, z.core.$strict>>;
                        sequence: z.ZodNumber;
                        stepIndex: z.ZodNumber;
                        turnId: z.ZodString;
                    }, z.core.$strict>;
                    kind: z.ZodLiteral<"subagent-input-request">;
                    subagentName: z.ZodString;
                }, z.core.$strict>;
                taskId: z.ZodString;
            }, z.core.$strict>>>;
            views: z.ZodOptional<z.ZodArray<z.ZodType<TaskView, unknown, z.core.$ZodTypeInternals<TaskView, unknown>>>>;
        }, z.core.$strict>>;
    }, z.core.$loose>>;
    requestId: z.ZodOptional<z.ZodString>;
    taskDeliveryId: z.ZodOptional<z.ZodString>;
    turnPolicy: z.ZodOptional<z.ZodEnum<{
        queue: "queue";
        steer: "steer";
    }>>;
    version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"session-timeout">;
    version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"clear">;
    version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"compact">;
    version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"reset">;
    reason: z.ZodOptional<z.ZodString>;
    version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"cancel">;
    taskId: z.ZodOptional<z.ZodString>;
    turnId: z.ZodOptional<z.ZodString>;
    version: z.ZodLiteral<1>;
}, z.core.$strict>], "kind">;
export type SessionInboxWireV1 = z.infer<typeof sessionInboxWireV1Schema>;
/** Builds and validates one complete version-1 wire value. */
export declare function encodeSessionCommandV1(command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload): SessionInboxWireV1;
