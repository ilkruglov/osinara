import { z } from 'zod/v4';
/**
 * graphile-worker is using JSON under the hood, so we need to base64 encode
 * the body to ensure binary safety
 * maybe later we can have a `blobs` table for larger payloads
 */
export declare const MessageData: z.ZodObject<{
    attempt: z.ZodNumber;
    messageId: z.core.$ZodBranded<z.ZodString, "MessageId", "out">;
    idempotencyKey: z.ZodOptional<z.ZodString>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    data: z.ZodCodec<z.ZodBase64, z.ZodCustom<Buffer<ArrayBufferLike>, Buffer<ArrayBufferLike>>>;
}, z.core.$strip>;
export type MessageData = z.infer<typeof MessageData>;
//# sourceMappingURL=message.d.ts.map