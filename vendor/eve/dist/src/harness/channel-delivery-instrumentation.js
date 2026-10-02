import {
  ActiveChannelDeliveriesKey,
  ParentTraceContextKey,
} from "#context/keys.js";
import { channelDeliveryIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
async function instrumentChannelDelivery(n) {
  if (!(`delivery` in n)) {
    let t = n.ctx.get(ActiveChannelDeliveriesKey);
    if (t === void 0 || n.hooks === void 0) return;
    let r = `channel.delivery.${n.outcome}`;
    for (let e of t)
      await n.hooks.publish({
        agentName: e.agentName,
        delivery: e.delivery,
        error: n.error,
        errorCode: n.errorCode,
        idempotencyKey: channelDeliveryIdempotencyKey(
          e.sessionId,
          e.delivery.deliveryId,
        ),
        outcome: n.outcome,
        rootSessionId: e.rootSessionId,
        sequence: n.includeTurn ? e.sequence : void 0,
        sessionId: e.sessionId,
        turnId: n.includeTurn ? e.turnId : void 0,
        type: r,
      });
    n.ctx.delete(ActiveChannelDeliveriesKey);
    return;
  }
  if (n.hooks === void 0 || n.delivery.deliveryMetadata === void 0) return;
  let r = [];
  for (let e of n.delivery.deliveryMetadata) {
    let i = n.delivery.payloads[e.payloadIndex],
      a = {
        channelKind: e.channelKind,
        channelName: e.channelName,
        deliveryId: e.deliveryId,
        requestId: e.requestId,
        requestTraceContext: e.requestTraceContext,
      },
      o =
        !n.hooks.capturesContent || i === void 0
          ? void 0
          : projectDeliveryInput(i),
      s = {
        agentName: n.agentName,
        delivery: a,
        rootSessionId: n.rootSessionId,
        sequence: n.sequence,
        sessionId: n.sessionId,
        turnId: n.turnId,
      };
    (r.push(s),
      await n.hooks.publish({
        agentName: s.agentName,
        delivery: a,
        idempotencyKey: channelDeliveryIdempotencyKey(
          n.sessionId,
          a.deliveryId,
        ),
        input: o,
        parentTraceContext: n.ctx.get(ParentTraceContextKey),
        rootSessionId: n.rootSessionId,
        sessionId: n.sessionId,
        type: `channel.delivery.started`,
      }));
  }
  r.length > 0 && n.ctx.set(ActiveChannelDeliveriesKey, r);
}
function projectDeliveryInput(e) {
  let t = {};
  return (
    e.context !== void 0 && (t.context = e.context),
    e.message !== void 0 && (t.message = e.message),
    e.outputSchema !== void 0 && (t.outputSchema = e.outputSchema),
    e.inputResponses !== void 0 &&
      (t.inputResponses = e.inputResponses.map((e) => {
        let t = {};
        return (
          e.optionId !== void 0 && (t.optionId = e.optionId),
          e.text !== void 0 && (t.text = e.text),
          t
        );
      })),
    t
  );
}
function channelDeliveryErrorCode(e) {
  if (typeof e == `object` && e && `code` in e) {
    let t = e.code;
    if (typeof t == `string` && t.length > 0) return t;
  }
  return `CHANNEL_DELIVERY_FAILED`;
}
export { channelDeliveryErrorCode, instrumentChannelDelivery };
