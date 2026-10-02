import { coalesceTurnInputs } from "#harness/messages.js";
const COALESCED_DELIVER_FIELDS = [
  `context`,
  `inputResponses`,
  `message`,
  `outputSchema`,
  `task`,
];
function coalesceDeliverPayloads(n) {
  if (n.length === 0) return {};
  if (n.length === 1) return n[0] ?? {};
  let r = {},
    i = [],
    a = [],
    o = [],
    s = {};
  for (let t of n) {
    (i.push(...(t.task?.inputRequests ?? [])),
      a.push(...(t.task?.authorizationEvents ?? [])),
      o.push(...(t.task?.views ?? [])));
    for (let [e, n] of Object.entries(t)) n !== void 0 && (r[e] = n);
    s = coalesceTurnInputs(s, t);
  }
  for (let e of COALESCED_DELIVER_FIELDS) delete r[e];
  let c = {};
  return (
    i.length > 0 && (c.inputRequests = i),
    a.length > 0 && (c.authorizationEvents = a),
    o.length > 0 && (c.views = o),
    Object.keys(c).length > 0 && (r.task = c),
    Object.assign(r, s)
  );
}
export { coalesceDeliverPayloads };
