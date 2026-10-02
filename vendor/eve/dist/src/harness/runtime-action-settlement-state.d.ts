import { ContextKey } from "#context/key.js";
/** Per-call acceptance times ferried through one internal turn step. */
export declare const RuntimeActionSettlementTimesKey: ContextKey<Readonly<Record<string, number>>>;
