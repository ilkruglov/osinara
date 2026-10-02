import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
function defineRemoteAgent(e) {
  return { ...e, kind: `remote`, path: e.path ?? EVE_SESSION_ROUTE_PATH };
}
export { defineRemoteAgent };
