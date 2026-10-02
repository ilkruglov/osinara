import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import {
  SessionInboxWireError,
  sessionInboxWire,
} from "#execution/wire/session-inbox-wire.js";
import { createHook } from "#compiled/@workflow/core/index.js";
import { closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import { turnCancellationHookToken } from "#execution/turn-cancellation-token.js";
import { forwardTurnCancellationStep } from "#execution/forward-turn-cancellation-step.js";
import { forwardTurnDeliveryStep } from "#execution/forward-turn-delivery-step.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
var TurnControlReceiver = class {
  bufferedDeliveries;
  bufferedSessionControls;
  commandInbox;
  control;
  controlIterator;
  expectedTurnId;
  cancelledTaskIds;
  seenTaskDeliveries;
  pendingControl = null;
  constructor(e) {
    ((this.bufferedDeliveries = e.bufferedDeliveries),
      (this.bufferedSessionControls = e.bufferedSessionControls),
      (this.cancelledTaskIds = e.cancelledTaskIds ?? new Set()),
      (this.commandInbox = e.commandInbox),
      (this.seenTaskDeliveries = e.seenTaskDeliveries ?? new Set()),
      (this.control = createHook({ token: e.token })),
      (this.controlIterator = this.control[Symbol.asyncIterator]()),
      (this.expectedTurnId = e.expectedTurnId));
  }
  get token() {
    return this.control.token;
  }
  async dispose() {
    (await closeHookIterator(this.controlIterator),
      await disposeHook(this.control));
  }
  async waitForAction() {
    for (;;) {
      let e = await this.nextControlOrCommand();
      if (e.kind === `command`) {
        let t = await this.handleSessionCommand(e.command);
        if (t !== void 0) return t;
        continue;
      }
      let t = e.payload,
        n = this.readTerminalControl(t);
      if (n !== void 0) return n;
      if (t.kind === `turn-delivery-request`) {
        let e = await this.serviceDeliveryRequest(t);
        if (e !== void 0) return e;
      }
    }
  }
  async handleSessionCommand(e) {
    if (e.kind === `deliver`) {
      if (!this.acceptTaskDelivery(e)) return;
      await this.bufferDelivery(e);
      return;
    }
    if (e.kind === `clear` || e.kind === `compact`) {
      this.bufferedSessionControls.push(e.kind);
      return;
    }
    if (e.kind === `session-timeout`) {
      this.bufferedSessionControls.push(`expired`);
      return;
    }
    if (e.kind === `cancel`) {
      e.taskId !== void 0 && this.discardTaskDeliveries(e.taskId);
      let t =
        e.taskId !== void 0 &&
        e.turnId !== void 0 &&
        e.turnId !== this.expectedTurnId
          ? void 0
          : e.turnId;
      await forwardTurnCancellationStep({
        payload: t === void 0 ? {} : { turnId: t },
        token: turnCancellationHookToken(this.control.token),
      });
      return;
    }
    if (e.kind === `reset`) {
      (await forwardTurnCancellationStep({
        payload: {},
        token: turnCancellationHookToken(this.control.token),
      }),
        this.bufferedSessionControls.push(`reset`));
      return;
    }
    return unsupportedSessionCommand(e);
  }
  async bufferDelivery(e) {
    (this.bufferedDeliveries.push(e),
      !(e.turnPolicy !== `steer` || !deliveryHasMessage(e)) &&
        (await forwardTurnCancellationStep({
          payload: {},
          token: turnCancellationHookToken(this.control.token),
        })));
  }
  bufferTurnDeliveries(e) {
    e.bufferedDeliveries !== void 0 &&
      this.bufferedDeliveries.unshift(
        ...e.bufferedDeliveries.filter((e) => !this.shouldDiscard(e)),
      );
  }
  consumeControl() {
    this.pendingControl = null;
  }
  getControlPromise() {
    return (
      (this.pendingControl ??= this.controlIterator.next()),
      this.pendingControl
    );
  }
  async nextControlOrCommand() {
    let r = await Promise.race([
      this.getControlPromise().then((e) => ({ kind: `control`, value: e })),
      this.commandInbox.next().then((e) => ({ kind: `command`, value: e })),
    ]);
    if (r.kind === `command`) {
      if (r.value.done)
        throw Error(
          `Session command inbox closed before the active turn settled.`,
        );
      if (
        (this.commandInbox.consumeNext(),
        r.value.value.kind === `runtime-action-result`)
      )
        return await this.nextControlOrCommand();
      try {
        return {
          command: sessionInboxWire.decode(r.value.value),
          kind: `command`,
        };
      } catch (n) {
        if (!(n instanceof SessionInboxWireError)) throw n;
        return (
          await reportDroppedWirePayloadStep({
            detail: n.message,
            family: `session-inbox`,
          }),
          await this.nextControlOrCommand()
        );
      }
    }
    if ((this.consumeControl(), r.value.done))
      throw Error(`Turn control hook closed before delivering a result.`);
    let i = r.value.value;
    if (i.kind === `turn-error`) throw rebuildSerializableError(i.error);
    return i.kind === `turn-continuation-token`
      ? (await this.commandInbox.rekeyContinuation(i.continuationToken),
        await this.nextControlOrCommand())
      : { kind: `control`, payload: i };
  }
  readTerminalControl(e) {
    if (e.kind === `turn-error`) throw rebuildSerializableError(e.error);
    if (e.kind === `turn-result`)
      return (this.bufferTurnDeliveries(e), e.action);
  }
  async serviceDeliveryRequest(r) {
    await this.commandInbox.rekeyContinuation(r.continuationToken);
    let i = this.takeInputResponseDelivery();
    for (; i === void 0; ) {
      let a = await Promise.race([
        this.getControlPromise().then((e) => ({ kind: `control`, value: e })),
        this.commandInbox.next().then((e) => ({ kind: `command`, value: e })),
      ]);
      if (a.kind === `control`) {
        if ((this.consumeControl(), a.value.done))
          throw Error(`Turn control hook closed during a delivery request.`);
        if (a.value.value.kind === `turn-continuation-token`) {
          await this.commandInbox.rekeyContinuation(
            a.value.value.continuationToken,
          );
          continue;
        }
        let e = this.readTerminalControl(a.value.value);
        if (e !== void 0) return e;
        if (
          a.value.value.kind === `turn-delivery-cancelled` &&
          a.value.value.requestId === r.requestId
        )
          return;
        continue;
      }
      if (a.value.done)
        throw Error(
          `Session command inbox closed during a turn delivery request.`,
        );
      if (
        (this.commandInbox.consumeNext(),
        a.value.value.kind === `runtime-action-result`)
      )
        continue;
      let o;
      try {
        o = sessionInboxWire.decode(a.value.value);
      } catch (n) {
        if (!(n instanceof SessionInboxWireError)) throw n;
        await reportDroppedWirePayloadStep({
          detail: n.message,
          family: `session-inbox`,
        });
        continue;
      }
      if (o.kind === `deliver`) {
        if (!this.acceptTaskDelivery(o)) continue;
        deliveryHasMessage(o) ? await this.bufferDelivery(o) : (i = o);
        continue;
      }
      let s = await this.handleSessionCommand(o);
      if (s !== void 0) return s;
    }
    try {
      await forwardTurnDeliveryStep({
        inboxToken: r.inboxToken,
        payload: {
          delivery: i,
          kind: `driver-delivery`,
          requestId: r.requestId,
        },
      });
    } catch (e) {
      if (!(e instanceof Error && e.name === `HookNotFoundError`)) throw e;
    }
    return await this.awaitForwardedDelivery(r.requestId, i);
  }
  takeInputResponseDelivery() {
    let e = this.bufferedDeliveries.findIndex((e) => !deliveryHasMessage(e));
    if (e !== -1) return this.bufferedDeliveries.splice(e, 1)[0];
  }
  async awaitForwardedDelivery(e, t) {
    for (;;) {
      let n = await this.nextControlOrCommand();
      if (n.kind === `command`) {
        let e = await this.handleSessionCommand(n.command);
        if (e !== void 0)
          return (
            this.shouldDiscard(t) || this.bufferedDeliveries.unshift(t),
            e
          );
        continue;
      }
      let r = n.payload;
      if (r.kind === `turn-delivery-accepted`) {
        if (r.requestId === e) return;
        continue;
      }
      if (r.kind === `turn-delivery-cancelled` && r.requestId === e) {
        this.shouldDiscard(t) || this.bufferedDeliveries.unshift(t);
        return;
      }
      r.kind === `turn-result` &&
        (this.shouldDiscard(t) || this.bufferedDeliveries.unshift(t));
      let i = this.readTerminalControl(r);
      if (i !== void 0) return i;
    }
  }
  acceptTaskDelivery(e) {
    let t = e.taskDeliveryId ?? e.caller?.taskId;
    return t === void 0
      ? !0
      : this.originatesFromCancelledTask(t) || this.seenTaskDeliveries.has(t)
        ? !1
        : (this.seenTaskDeliveries.add(t), !0);
  }
  discardTaskDeliveries(e) {
    this.cancelledTaskIds.add(e);
    let t = this.bufferedDeliveries.filter((e) => !this.shouldDiscard(e));
    this.bufferedDeliveries.splice(0, this.bufferedDeliveries.length, ...t);
  }
  originatesFromCancelledTask(e) {
    return [...this.cancelledTaskIds].some((t) =>
      deliveryOriginatesFromTask(e, t),
    );
  }
  shouldDiscard(e) {
    let t = e.taskDeliveryId ?? e.caller?.taskId;
    return t !== void 0 && this.originatesFromCancelledTask(t);
  }
};
function deliveryOriginatesFromTask(e, t) {
  return e === t || e.startsWith(`${t}:`);
}
function deliveryHasMessage(e) {
  return e.payloads.some((e) => e.message !== void 0);
}
function unsupportedSessionCommand(e) {
  throw Error(`Unsupported session command: ${JSON.stringify(e)}`);
}
export { TurnControlReceiver };
