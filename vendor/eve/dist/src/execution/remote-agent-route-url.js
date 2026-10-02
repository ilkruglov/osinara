function createRemoteAgentRouteUrl(e, t) {
  return new URL(t.replace(/^\/+/, ``), `${trimTrailingSlash(e)}/`).toString();
}
function trimTrailingSlash(e) {
  return e.endsWith(`/`) ? e.slice(0, -1) : e;
}
export { createRemoteAgentRouteUrl };
