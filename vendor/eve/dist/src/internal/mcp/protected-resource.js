import { escapeAuthChallengeParameter } from "#public/channels/auth.js";
function createMcpProtectedResourceMetadata(e) {
  let t = {
    authorization_servers: e.authorizationServers,
    resource: e.resource,
  };
  return (
    e.scopesSupported !== void 0 && (t.scopes_supported = e.scopesSupported),
    t
  );
}
function createMcpResourceChallenge(t, n) {
  let r = [`resource_metadata="${escapeAuthChallengeParameter(t)}"`];
  return (
    n?.length && r.push(`scope="${escapeAuthChallengeParameter(n.join(` `))}"`),
    `Bearer ${r.join(`, `)}`
  );
}
export { createMcpProtectedResourceMetadata, createMcpResourceChallenge };
