import type { UserContent } from "ai";
import type { SendPayload } from "#channel/routes.js";
/** Normalizes the shorthand input forms accepted by channel and session sends. */
export declare function normalizeSendInput(input: string | UserContent | SendPayload): SendPayload;
/** Serializes non-data URL file parts before input crosses the durable boundary. */
export declare function serializeUrlFilePartsInMessage(message: string | UserContent | undefined): string | UserContent | undefined;
