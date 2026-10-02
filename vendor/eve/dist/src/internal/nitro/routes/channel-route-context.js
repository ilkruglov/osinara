const agentInfoRouteResponseKey = `__eveAgentInfoRouteResponse`,
  routeChannelNameKey = `__eveRouteChannelName`,
  remoteAgentStreamHeadersResolverKey = `__eveRemoteAgentStreamHeadersResolver`,
  routeSessionCreatorKey = `__eveRouteSessionCreator`;
function attachRouteChannelName(e, n) {
  let r = e;
  return ((r[routeChannelNameKey] = n), e);
}
function readRouteChannelName(e) {
  return e[routeChannelNameKey];
}
function attachAgentInfoRouteResponse(t, n) {
  let r = t;
  return ((r[agentInfoRouteResponseKey] = n), t);
}
function readAgentInfoRouteResponse(t) {
  return t[agentInfoRouteResponseKey];
}
function attachRouteSessionCreator(e, t) {
  let n = e;
  return ((n[routeSessionCreatorKey] = t), e);
}
function readRouteSessionCreator(e) {
  return e[routeSessionCreatorKey];
}
function attachRemoteAgentStreamHeadersResolver(e, t) {
  let r = e;
  return ((r[remoteAgentStreamHeadersResolverKey] = t), e);
}
function readRemoteAgentStreamHeadersResolver(e) {
  return e[remoteAgentStreamHeadersResolverKey];
}
export {
  attachAgentInfoRouteResponse,
  attachRemoteAgentStreamHeadersResolver,
  attachRouteChannelName,
  attachRouteSessionCreator,
  readAgentInfoRouteResponse,
  readRemoteAgentStreamHeadersResolver,
  readRouteChannelName,
  readRouteSessionCreator,
};
