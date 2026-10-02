import {
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { join, relative } from "node:path";
import { serializeOutputSchema } from "#shared/tool-schema.js";
import { createCompiledSubagentNodeId } from "#compiler/manifest.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";
import { createPathDerivedSourceId } from "#discover/manifest.js";
import { isDynamicSentinel } from "#shared/dynamic-tool-definition.js";
import { composeAgentSubagentSources } from "#compiler/normalize-extension.js";
const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set([
  `session.started`,
  `turn.started`,
]);
async function compileSubagentGraph(e) {
  let t = [],
    n = [],
    r = [];
  for (let i of e.subagents) {
    let a = await compileSubagentDefinition({
      appRoot: e.appRoot,
      compileAgentNodeManifest: e.compileAgentNodeManifest,
      compileAgentResources: e.compileAgentResources,
      context: e.context,
      externalDependencies: e.externalDependencies,
      parentAgentRoot: e.parentAgentRoot,
      parentNodeId: e.parentNodeId,
      source: i,
    });
    if (a.kind === `remote`) {
      r.push(a.node);
      continue;
    }
    (t.push(a.node, ...a.descendants.nodes),
      n.push(
        { childNodeId: a.node.nodeId, parentNodeId: e.parentNodeId },
        ...a.descendants.edges,
      ));
  }
  return { edges: n, nodes: t, remoteAgents: r };
}
async function compileSubagentDefinition(e) {
  let t = e.source.manifest.configModule;
  if (t === void 0)
    throw Error(
      `Subagent "${e.source.logicalPath}" is missing an agent config module.`,
    );
  let n = createSubagentConfigModuleSourceRef(e.source, t, e.parentAgentRoot),
    r = await loadModuleBackedDefinition({
      agentRoot: e.source.manifest.agentRoot,
      displayPath: n.logicalPath,
      externalDependencies: e.externalDependencies,
      kind: `subagent config`,
      source: t,
    }),
    i = normalizeDynamicSubagentDefinition(
      r,
      `Expected the dynamic subagent config export "${t.exportName ?? `default`}" from "${n.logicalPath}" to match the public eve shape.`,
    );
  return i === void 0 && readAgentDefinitionKind(r) === `remote`
    ? {
        kind: `remote`,
        node: compileRemoteAgent({
          parentAgentRoot: e.parentAgentRoot,
          source: e.source,
          value: r,
        }),
      }
    : {
        kind: `local`,
        ...(await compileLocalSubagent({
          ...e,
          agentConfigDefinition: i === void 0 ? r : void 0,
          configResolver:
            i === void 0 ? void 0 : { ...t, ...i.definition, build: i.build },
        })),
      };
}
async function compileSubagent(e) {
  let t = createCompiledSubagentNodeId(e.parentNodeId, e.source.sourceId),
    n = e.source.subagentId,
    r = { ...e.source.manifest, appRoot: e.appRoot },
    i = mergeExternalDependencies(
      e.externalDependencies,
      e.configResolver?.build?.externalDependencies,
    ),
    a = {
      entryPath: e.source.entryPath,
      logicalPath: e.source.logicalPath,
      name: n,
      nodeId: t,
      rootPath: e.source.rootPath,
      sourceId: e.source.sourceId,
      sourceKind: `module`,
    };
  if (e.configResolver === void 0) {
    let n = await e.compileAgentNodeManifest(r, e.context, {
        agentConfigDefinition: e.agentConfigDefinition,
        allowRootOnlyConfig: !1,
        externalDependencies: i,
      }),
      o = n.config.description;
    if (!o)
      throw Error(
        `Local subagent "${e.source.logicalPath}" is missing a "description" field on its agent config. Add \`description\` to \`defineAgent({ ... })\` so the parent agent can decide when to delegate to this subagent.`,
      );
    let s = await compileSubagentGraph({
      appRoot: e.appRoot,
      compileAgentNodeManifest: e.compileAgentNodeManifest,
      context: e.context,
      compileAgentResources: e.compileAgentResources,
      externalDependencies: n.config.build?.externalDependencies ?? i,
      parentAgentRoot: e.source.manifest.agentRoot,
      parentNodeId: t,
      subagents: composeAgentSubagentSources(e.source.manifest),
    });
    return {
      descendants: s,
      node: {
        ...a,
        agent: { ...n, remoteAgents: [...s.remoteAgents] },
        description: o,
      },
    };
  }
  let o = await e.compileAgentResources(r, e.context, {
      externalDependencies: i,
    }),
    s = await compileSubagentGraph({
      appRoot: e.appRoot,
      compileAgentNodeManifest: e.compileAgentNodeManifest,
      context: e.context,
      compileAgentResources: e.compileAgentResources,
      externalDependencies: i,
      parentAgentRoot: e.source.manifest.agentRoot,
      parentNodeId: t,
      subagents: composeAgentSubagentSources(e.source.manifest),
    });
  return {
    descendants: s,
    node: {
      ...a,
      agent: { ...o, remoteAgents: [...s.remoteAgents] },
      configResolver: e.configResolver,
    },
  };
}
const compileLocalSubagent = compileSubagent;
function compileRemoteAgent(e) {
  let t = e.source.manifest.configModule;
  if (t === void 0)
    throw Error(
      `Remote agent "${e.source.logicalPath}" is missing a config module.`,
    );
  assertRemoteAgentDefinitionHasNoLocalPackageEntries(e.source);
  let n = createSubagentConfigModuleSourceRef(e.source, t, e.parentAgentRoot),
    r = normalizeRemoteAgentDefinition(
      e.value,
      `Expected the remote agent config export "${t.exportName ?? `default`}" from "${n.logicalPath}" to match the public eve shape.`,
    ),
    i = {
      ...n,
      description: r.description,
      entryPath: e.source.entryPath,
      name: e.source.subagentId,
      nodeId: e.source.sourceId,
      outputSchema: r.outputSchema,
      path: r.path,
      rootPath: e.source.rootPath,
    };
  return r.url === void 0 ? i : { ...i, url: r.url };
}
function normalizeDynamicSubagentDefinition(e, i) {
  if (!isDynamicSentinel(e)) return;
  let a = expectObjectRecord(e, i);
  expectOnlyKnownKeys(a, [`build`, `events`, `kind`], i);
  let o =
      a.build === void 0 ? void 0 : normalizeDynamicSubagentBuild(a.build, i),
    s = expectObjectRecord(a.events, i),
    c = [];
  for (let [e, n] of Object.entries(s)) {
    if (!ALLOWED_DYNAMIC_SUBAGENT_EVENTS.has(e))
      throw Error(
        `${i} Dynamic subagents support only "session.started" and "turn.started" handlers.`,
      );
    (expectFunction(n, i), c.push(e));
  }
  let l = { definition: { eventNames: c } };
  return (o !== void 0 && (l.build = o), l);
}
function normalizeDynamicSubagentBuild(e, t) {
  let a = expectObjectRecord(e, t);
  if (
    (expectOnlyKnownKeys(a, [`externalDependencies`], t),
    a.externalDependencies === void 0)
  )
    return {};
  if (!Array.isArray(a.externalDependencies)) throw Error(t);
  return {
    externalDependencies: a.externalDependencies.map((e) => expectString(e, t)),
  };
}
function mergeExternalDependencies(...e) {
  return [...new Set(e.flatMap((e) => e ?? []))];
}
function createSubagentConfigModuleSourceRef(e, t, n) {
  let r = relative(n, join(e.manifest.agentRoot, t.logicalPath)).replaceAll(
      `\\`,
      `/`,
    ),
    i = {
      logicalPath: r,
      sourceId:
        t.sourceId.startsWith(`ext:`) || t.sourceId.startsWith(`ext-override:`)
          ? t.sourceId
          : createPathDerivedSourceId(r),
      sourceKind: `module`,
    };
  return (t.exportName !== void 0 && (i.exportName = t.exportName), i);
}
function readAgentDefinitionKind(e) {
  return typeof e != `object` || !e
    ? `local`
    : e.kind === `remote`
      ? `remote`
      : `local`;
}
function normalizeRemoteAgentDefinition(t, o) {
  let s = expectObjectRecord(t, o);
  if (
    (expectOnlyKnownKeys(
      s,
      [
        `auth`,
        `description`,
        `forwardPrincipal`,
        `headers`,
        `kind`,
        `outputSchema`,
        `path`,
        `url`,
      ],
      o,
    ),
    s.kind !== `remote`)
  )
    throw Error(`${o} Expected "kind" to be "remote".`);
  return (
    s.forwardPrincipal !== void 0 &&
      expectBoolean(
        s.forwardPrincipal,
        `${o} Expected "forwardPrincipal" to be a boolean.`,
      ),
    {
      description: expectString(s.description, o),
      outputSchema: serializeOutputSchema(s.outputSchema),
      path:
        s.path === void 0 ? EVE_SESSION_ROUTE_PATH : expectString(s.path, o),
      url: typeof s.url == `function` ? void 0 : expectString(s.url, o),
    }
  );
}
function assertRemoteAgentDefinitionHasNoLocalPackageEntries(e) {
  let t = e.manifest,
    n = [
      t.connections.length > 0 ? `connections/` : void 0,
      t.hooks.length > 0 ? `hooks/` : void 0,
      t.instructions.length > 0 ? `instructions` : void 0,
      t.lib.length > 0 ? `lib/` : void 0,
      t.sandbox === null ? void 0 : `sandbox/`,
      t.sandboxWorkspaces.length > 0 ? `sandbox/workspace/` : void 0,
      t.schedules.length > 0 ? `schedules/` : void 0,
      t.skills.length > 0 ? `skills/` : void 0,
      t.subagents.length > 0 ? `subagents/` : void 0,
      t.tools.length > 0 ? `tools/` : void 0,
    ].filter((e) => e !== void 0);
  if (n.length !== 0)
    throw Error(
      `Remote subagent definition "${e.logicalPath}" cannot include local package entries. Remove unsupported entries: ${n.join(`, `)}.`,
    );
}
export { compileSubagentGraph };
