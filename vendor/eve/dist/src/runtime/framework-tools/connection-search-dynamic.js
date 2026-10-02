import { createLogger } from "#internal/logging.js";
import { z } from "#compiled/zod/index.js";
import { toError } from "#shared/errors.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import {
  consumeAuthorizationResult,
  createAuthorizationAttempt,
  requestAuthorization,
} from "#harness/authorization.js";
import { supportsInteractiveAuthorization } from "#runtime/connections/types.js";
import {
  resolveAuthorizationCallbackUrl,
  stampChallengeDisplayName,
} from "#runtime/connections/scoped-authorization.js";
import { defineDynamic, defineTool } from "#public/definitions/tool.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import { writeCachedToken } from "#runtime/connections/authorization-tokens.js";
import {
  principalKey,
  resolveConnectionPrincipal,
} from "#runtime/connections/principal.js";
var __eveStepRegistrySym = Symbol.for(`@workflow/core//registeredSteps`);
globalThis[__eveStepRegistrySym] ||
  (globalThis[__eveStepRegistrySym] = new Map());
var __eveStepRegistry = globalThis[__eveStepRegistrySym];
const logger = createLogger(`framework.connection-search-dynamic`),
  CONNECTION_SEARCH_INPUT_SCHEMA = z.strictObject({
    connection: z
      .string()
      .describe(`Optional: limit search to a specific connection name.`)
      .optional(),
    keywords: z
      .string()
      .describe(
        `Search keywords and expanded aliases. Distill intent into keywords; avoid stop words like 'a', 'the', 'in'.`,
      ),
    limit: z.number().describe(`Max results to return. Default 10.`).optional(),
  }),
  connectionSchema = z.looseObject({}),
  CONNECTION_SEARCH_RESULT_ITEM_SCHEMA = z.strictObject({
    connection: z.string(),
    description: z.string(),
    error: z.string().optional(),
    inputSchema: connectionSchema.optional(),
    needsAuthorization: z.boolean().optional(),
    outputSchema: connectionSchema.optional(),
    qualifiedName: z.string().optional(),
    tool: z.string().optional(),
  }),
  CONNECTION_SEARCH_OUTPUT_SCHEMA = z.array(
    CONNECTION_SEARCH_RESULT_ITEM_SCHEMA,
  ),
  ConnectionSearchResultsKey = new ContextKey(`eve.connectionSearchResults`);
function qualifiedConnectionToolName(e, t) {
  return `${e}__${t}`;
}
function tokenize(e) {
  return e
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((e) => e.length > 1);
}
function scoreMatch(e, t) {
  let n = tokenize(t.name),
    r = tokenize(t.description),
    i = 0;
  for (let t of e) {
    for (let e of n) (e.includes(t) || t.includes(e)) && (i += 3);
    for (let e of r) (e.includes(t) || t.includes(e)) && (i += 1);
  }
  return i;
}
async function resolveInteractiveAuth(e, t) {
  let n = e.getConnections().find((e) => e.connectionName === t);
  if (n === void 0) return;
  let r = await resolveConnectionAuthorization(n);
  if (supportsInteractiveAuthorization(r)) return r;
}
async function completePendingAuthorizations(e, t) {
  let n = loadContext(),
    i = new Set();
  for (let r of t) {
    let t = consumeAuthorizationResult(r.connectionName);
    if (!t) continue;
    let a = await resolveInteractiveAuth(e, r.connectionName);
    if (!a) continue;
    let o = t.principal ?? resolveConnectionPrincipal(r.connectionName, a),
      s = await a.completeAuthorization({
        callbackUrl: t.hookUrl,
        connection: { url: r.url ?? `` },
        principal: o,
        resume: t.resume,
        callback: t.callback,
      });
    (writeCachedToken(n, r.connectionName, principalKey(o), s),
      i.add(r.connectionName));
  }
  return i;
}
async function executeConnectionSearch(e) {
  let t = loadContext(),
    i = t.get(ConnectionRegistryKey);
  if (i === void 0) return [];
  let o = e.limit ?? 10,
    l = tokenize(e.keywords),
    d = [],
    f = [],
    p =
      e.connection !== void 0 && e.connection !== ``
        ? i.getConnections().filter((t) => t.connectionName === e.connection)
        : i.getConnections();
  if (e.connection && p.length === 0)
    throw Error(
      `Connection "${e.connection}" is not registered. Available connections: ${i.getConnectionNames().join(`, `)}.`,
    );
  let m = await completePendingAuthorizations(i, p),
    h = [];
  for (let e of p) {
    let t;
    try {
      t = await i.getClient(e.connectionName).getToolMetadata();
    } catch (t) {
      if (isConnectionAuthorizationRequiredError(t)) {
        if (m.has(e.connectionName)) {
          (logger.warn(`connection still unauthorized after authorization`, {
            connection: e.connectionName,
          }),
            f.push({
              connection: e.connectionName,
              description: e.description,
              error: `Authorization for "${e.connectionName}" did not take effect; the token was rejected after sign-in.`,
            }));
          continue;
        }
        let t = await resolveInteractiveAuth(i, e.connectionName);
        if (t) {
          let r = createAuthorizationAttempt(e.connectionName);
          if (r) {
            let i = resolveConnectionPrincipal(e.connectionName, t),
              a = resolveAuthorizationCallbackUrl({
                authorization: t,
                callbackUrl: r.hookUrl,
              });
            try {
              let { challenge: n, resume: o } = await t.startAuthorization({
                callbackUrl: a,
                connection: { url: e.url ?? `` },
                principal: i,
              });
              h.push({
                attemptId: r.attemptId,
                name: e.connectionName,
                challenge: stampChallengeDisplayName(n, t),
                hookUrl: a,
                principal: i,
                resume: o,
              });
            } catch (t) {
              let r = toError(t);
              (logger.warn(`startAuthorization failed`, {
                connection: e.connectionName,
                error: r,
              }),
                f.push({
                  connection: e.connectionName,
                  description: e.description,
                  error: `Failed to start authorization for "${e.connectionName}": ${r.message}`,
                }));
              continue;
            }
          }
        }
        f.push({
          connection: e.connectionName,
          description: e.description,
          needsAuthorization: !0,
        });
        continue;
      }
      if (isConnectionAuthorizationFailedError(t)) {
        (logger.warn(`connection authorization failed`, {
          connection: e.connectionName,
          reason: t.reason,
          retryable: t.retryable,
          error: t,
        }),
          f.push({
            connection: e.connectionName,
            description: e.description,
            error: `Authorization failed for ${e.connectionName}: ${t.message}`,
          }));
        continue;
      }
      let r = toError(t);
      (logger.warn(`failed to load connection tools`, {
        connection: e.connectionName,
        error: r,
      }),
        f.push({
          connection: e.connectionName,
          description: e.description,
          error: `Failed to load tools for "${e.connectionName}": ${r.message}`,
        }));
      continue;
    }
    for (let n of t) {
      let t = scoreMatch(l, n);
      t > 0 &&
        d.push({
          item: {
            connection: e.connectionName,
            description: n.description,
            inputSchema: n.inputSchema,
            outputSchema: n.outputSchema,
            qualifiedName: qualifiedConnectionToolName(
              e.connectionName,
              n.name,
            ),
            tool: n.name,
          },
          score: t,
        });
    }
  }
  if (h.length > 0) return requestAuthorization(h);
  let g = f.filter((e) => e.error !== void 0);
  if (p.length > 0 && g.length === p.length)
    throw Error(
      g.map((e) => e.error).join(`
`),
    );
  d.sort((e, t) => t.score - e.score);
  let _ = d.slice(0, o).map((e) => e.item);
  if (_.length > 0) {
    let e = [..._, ...f],
      n = t.get(ConnectionSearchResultsKey) ?? [],
      r = new Map(n.map((e) => [e.qualifiedName, e]));
    for (let e of _) e.qualifiedName && r.set(e.qualifiedName, e);
    return (t.set(ConnectionSearchResultsKey, [...r.values()]), e);
  }
  return p.map(
    (e) =>
      f.find((t) => t.connection === e.connectionName) || {
        connection: e.connectionName,
        description: e.description,
      },
  );
}
function extractDiscoveredTools(e) {
  let t = new Map();
  for (let n of e) {
    if (n.role !== `tool`) continue;
    let e = n.content;
    for (let n of e) {
      if (n.type !== `tool-result` || n.toolName !== `connection_search`)
        continue;
      let e = n.output;
      if (e == null) continue;
      let r = typeof e == `object` && `type` in e && `value` in e ? e.value : e;
      if (Array.isArray(r))
        for (let e of r) e.tool && e.qualifiedName && t.set(e.qualifiedName, e);
    }
  }
  return [...t.values()];
}
const connectionSearchDynamicDefinition = defineDynamic({
  events: {
    "step.started": async (e, t) => {
      let n = loadContext().get(ConnectionRegistryKey);
      if (!n || n.getConnections().length === 0) return null;
      let i = n.getConnections().map((e) => e.connectionName),
        o = extractDiscoveredTools(t.messages),
        s = loadContext().get(ConnectionSearchResultsKey) ?? [],
        c = new Map();
      for (let e of s) e.qualifiedName && c.set(e.qualifiedName, e);
      for (let e of o) e.qualifiedName && c.set(e.qualifiedName, e);
      let l = [...c.values()],
        u = {};
      u.connection_search = defineTool({
        description: `Search for tools across your connections. Discovered tools become directly callable by their qualified name (e.g. \`linear__list_issues\`) in your next response. Available connections: ${i.join(`, `)}.`,
        inputSchema: CONNECTION_SEARCH_INPUT_SCHEMA,
        execute: async (e) => await __eve_dynamic_exec_0({}, e),
        __executeStepFn: __eve_dynamic_exec_0,
        __closureVars: {},
        outputSchema: CONNECTION_SEARCH_OUTPUT_SCHEMA,
      });
      for (let e of l) {
        let r = e.connection,
          i = e.tool,
          a = n.getConnectionApproval(r);
        u[qualifiedConnectionToolName(r, i)] = defineTool({
          description: e.description,
          inputSchema: e.inputSchema ?? { type: `object` },
          approval: a,
          outputSchema: e.outputSchema,
          execute: async (e, n) =>
            await __eve_dynamic_exec_1(
              { ctx: t, connectionName: r, toolName: i },
              e,
              n,
            ),
          __executeStepFn: __eve_dynamic_exec_1,
          __closureVars: { ctx: t, connectionName: r, toolName: i },
        });
      }
      return u;
    },
  },
});
async function __eve_dynamic_exec_0(e, t) {
  return executeConnectionSearch(t);
}
async function __eve_dynamic_exec_1(e, t, n) {
  let { ctx: i, connectionName: s, toolName: d } = e,
    f = loadContext().get(ConnectionRegistryKey),
    p = f.getConnections().find((e) => e.connectionName === s),
    m = await resolveInteractiveAuth(f, s),
    _ = !1;
  if (m) {
    let e = consumeAuthorizationResult(s);
    if (e) {
      _ = !0;
      let t = loadContext(),
        n = e.principal ?? resolveConnectionPrincipal(s, m),
        i = await m.completeAuthorization({
          callbackUrl: e.hookUrl,
          connection: { url: p?.url ?? `` },
          principal: n,
          resume: e.resume,
          callback: e.callback,
        });
      writeCachedToken(t, s, principalKey(n), i);
    }
  }
  try {
    return await f
      .getClient(s)
      .executeTool(d, t, { abortSignal: n.abortSignal });
  } catch (e) {
    if (!isConnectionAuthorizationRequiredError(e) || !m) throw e;
    if (_)
      throw new ConnectionAuthorizationFailedError(s, {
        retryable: !1,
        reason: `token_rejected_after_authorization`,
        message: `Connection "${s}" rejected the token immediately after authorization.`,
      });
    let t = createAuthorizationAttempt(s);
    if (!t) throw e;
    let n = resolveConnectionPrincipal(s, m),
      r = resolveAuthorizationCallbackUrl({
        authorization: m,
        callbackUrl: t.hookUrl,
      }),
      { challenge: i, resume: a } = await m.startAuthorization({
        callbackUrl: r,
        connection: { url: p?.url ?? `` },
        principal: n,
      });
    return requestAuthorization([
      {
        attemptId: t.attemptId,
        name: s,
        challenge: stampChallengeDisplayName(i, m),
        hookUrl: r,
        principal: n,
        resume: a,
      },
    ]);
  }
}
((__eve_dynamic_exec_0.stepId = `eve:dynamic-tool//__eve_dynamic_exec_0`),
  __eveStepRegistry.set(
    `eve:dynamic-tool//__eve_dynamic_exec_0`,
    __eve_dynamic_exec_0,
  ),
  (__eve_dynamic_exec_1.stepId = `eve:dynamic-tool//__eve_dynamic_exec_1`),
  __eveStepRegistry.set(
    `eve:dynamic-tool//__eve_dynamic_exec_1`,
    __eve_dynamic_exec_1,
  ));
export { connectionSearchDynamicDefinition as default, extractDiscoveredTools };
