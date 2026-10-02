import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import {
  emitRecordedTaskAuthorizationEventStep,
  emitRecordedTaskInputRequestStep,
} from "#execution/subagent-event-proxy-step.js";
import {
  acceptTaskAuthorizationEventStep,
  recordTaskInputRequestStep,
  recordTerminalTaskViewsStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";
async function routeDeliverToChildren(i) {
  let a = coalesceDeliverPayloads(i.delivery.payloads),
    o = i.serializedContext,
    s = i.sessionState;
  (a.task?.views?.length ?? 0) > 0 &&
    (s = await recordTerminalTaskViewsStep({
      sessionState: s,
      views: a.task?.views ?? [],
    }));
  for (let e of a.task?.inputRequests ?? []) {
    let t = await recordTaskInputRequestStep({
      hookPayload: e.hookPayload,
      serializedContext: o,
      sessionState: s,
      taskId: e.taskId,
    });
    if (((s = t.sessionState), !t.accepted)) continue;
    let n = await emitRecordedTaskInputRequestStep({
      hookPayload: t.hookPayload,
      parentWritable: i.parentWritable,
      serializedContext: o,
      sessionState: s,
    });
    ((o = n.serializedContext), (s = n.sessionState));
  }
  for (let e of a.task?.authorizationEvents ?? []) {
    if (
      !(await acceptTaskAuthorizationEventStep({
        hookPayload: e.hookPayload,
        sessionState: s,
        taskId: e.taskId,
      }))
    )
      continue;
    let t = await emitRecordedTaskAuthorizationEventStep({
      hookPayload: e.hookPayload,
      parentWritable: i.parentWritable,
      serializedContext: o,
      sessionState: s,
    });
    ((o = t.serializedContext), (s = t.sessionState));
  }
  let c = [],
    l = [];
  for (let [e, t] of i.delivery.payloads.entries()) {
    let n = { ...t };
    if ((delete n.task, Object.keys(n).length === 0)) continue;
    let r = c.length;
    c.push(n);
    for (let t of i.delivery.deliveryMetadata ?? [])
      t.payloadIndex === e && l.push({ ...t, payloadIndex: r });
  }
  let u =
    c.length === 0
      ? void 0
      : {
          ...i.delivery,
          deliveryMetadata: l.length === 0 ? void 0 : l,
          payloads: c,
        };
  return u === void 0
    ? {
        kind: `continue`,
        remainder: void 0,
        serializedContext: o,
        sessionState: s,
      }
    : s.hasProxyInputRequests
      ? await routeProxiedDeliverStep({
          delivery: u,
          parentWritable: i.parentWritable,
          serializedContext: o,
          sessionState: s,
        })
      : {
          kind: `continue`,
          remainder: u,
          serializedContext: o,
          sessionState: s,
        };
}
export { routeDeliverToChildren };
