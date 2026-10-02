import type { DeliverHookPayload } from "#channel/types.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
export type TurnDriverAction = NextDriverAction;
/** Owns one turn's driver-side control hook and public-delivery relay state. */
export declare class TurnControlReceiver {
    private readonly bufferedDeliveries;
    private readonly bufferedSessionControls;
    private readonly commandInbox;
    private readonly control;
    private readonly controlIterator;
    private readonly expectedTurnId;
    private readonly cancelledTaskIds;
    private readonly seenTaskDeliveries;
    private pendingControl;
    constructor(input: {
        readonly bufferedDeliveries: DeliverHookPayload[];
        readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
        readonly cancelledTaskIds?: Set<string>;
        readonly commandInbox: SessionCommandInbox;
        readonly expectedTurnId: string;
        readonly seenTaskDeliveries?: Set<string>;
        readonly token: string;
    });
    /** Token passed to the turn workflow so it can publish control messages. */
    get token(): string;
    /** Releases the turn control hook and its iterator. */
    dispose(): Promise<void>;
    /** Services control messages until the active turn returns its terminal driver action. */
    waitForAction(): Promise<TurnDriverAction>;
    private handleSessionCommand;
    private bufferDelivery;
    private bufferTurnDeliveries;
    private consumeControl;
    private getControlPromise;
    private nextControlOrCommand;
    private readTerminalControl;
    private serviceDeliveryRequest;
    private takeInputResponseDelivery;
    /**
     * Waits for the active turn to resolve a forwarded delivery. The turn either
     * accepts it (consumed) or releases it on cancellation or termination, in
     * which case the delivery returns behind remainders from earlier deliveries
     * accepted by the turn and ahead of deliveries that arrived later.
     */
    private awaitForwardedDelivery;
    private acceptTaskDelivery;
    private discardTaskDeliveries;
    private originatesFromCancelledTask;
    private shouldDiscard;
}
