import { isChatGptModelRouting } from "#shared/chatgpt-model.js";
function hasEnvValue(e) {
  return e !== void 0 && e.trim().length > 0;
}
function resolveGatewayCredential(e) {
  let t =
      e.apiKeyFile === void 0
        ? e.apiKeyInEnv === !0
          ? { kind: `shell` }
          : void 0
        : { kind: `env-file`, path: e.apiKeyFile },
    n = e.oidcFile !== void 0 || e.oidcAvailable === !0;
  if (t !== void 0) return { credential: `api-key`, source: t };
  if (n)
    return e.oidcFile === void 0
      ? { credential: `oidc` }
      : { credential: `oidc`, file: e.oidcFile };
}
function resolveModelEndpointStatus(t, n, r) {
  if (t.kind === `external`)
    return isChatGptModelRouting(t) && r !== void 0
      ? { kind: `chatgpt`, ...r }
      : { kind: `external`, provider: t.provider };
  let i = resolveGatewayCredential({
    apiKeyInEnv: n.apiKey,
    oidcAvailable: n.oidc,
  });
  return i === void 0
    ? { kind: `gateway`, connected: !1 }
    : { kind: `gateway`, connected: !0, credential: i.credential };
}
export { hasEnvValue, resolveGatewayCredential, resolveModelEndpointStatus };
