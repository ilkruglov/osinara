import { z } from "#compiled/zod/index.js";
/** Outcome of requesting cooperative turn cancellation. */
export type CancelTurnStatus = "accepted" | "no_active_turn";
/** Transport-independent result of requesting cooperative turn cancellation. */
export type CancelTurnResult = {
    readonly sessionId: string;
    readonly status: "accepted";
} | {
    readonly status: "no_active_turn";
};
/** Successful standard turn-cancellation response. */
export type CancelTurnResponse = CancelTurnResult & {
    readonly ok: true;
};
/** Successful response returned by the standard turn-cancellation route. */
export declare const CancelTurnResponseSchema: z.ZodType<CancelTurnResponse>;
