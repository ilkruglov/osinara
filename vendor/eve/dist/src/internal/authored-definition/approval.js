import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
function normalizeApproval(e, t) {
  if (typeof e == `function`) return e;
  let n = expectObjectRecord(e, t);
  expectOnlyKnownKeys(n, [`request`, `response`], t);
  let r = expectFunction(n.request, t);
  return n.response === void 0
    ? { request: r }
    : { request: r, response: expectFunction(n.response, t) };
}
export { normalizeApproval };
