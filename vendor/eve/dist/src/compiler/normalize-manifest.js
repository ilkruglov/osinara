import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  createCompiledAgentResources,
} from "#compiler/manifest.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import {
  mountRefNamespace,
  packageStateNamespace,
} from "#discover/extensions.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import {
  compileExtensionContributions,
  composeAgentSubagentSources,
} from "#compiler/normalize-extension.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileSubagentGraph } from "#compiler/normalize-subagent.js";
async function compileAgentManifest(e) {
  let r = { modelCatalog: createCompiledRuntimeModelCatalogLoader(e.appRoot) },
    i = await compileAgentNodeManifest(e, r),
    a = await compileSubagentGraph({
      appRoot: e.appRoot,
      compileAgentNodeManifest,
      compileAgentResources,
      context: r,
      externalDependencies: i.config.build?.externalDependencies ?? [],
      parentAgentRoot: e.agentRoot,
      parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
      subagents: composeAgentSubagentSources(e),
    });
  return createCompiledAgentManifest({
    ...i,
    extensionMounts: i.extensionMounts,
    remoteAgents: a.remoteAgents,
    subagentEdges: a.edges,
    subagents: a.nodes,
  });
}
async function compileAgentNodeManifest(e, t, n = {}) {
  let i = Object.hasOwn(n, `agentConfigDefinition`)
    ? await compileAgentConfig(e, t, { definition: n.agentConfigDefinition })
    : await compileAgentConfig(e, t);
  if (n.allowRootOnlyConfig === !1 && i.experimental?.workflow !== void 0)
    throw Error(
      `Workflow runtime configuration is only supported on the root agent config. Remove "experimental.workflow" from "${e.agentId}".`,
    );
  if (n.allowRootOnlyConfig === !1 && i.experimental?.tasks !== void 0)
    throw Error(
      `Background tasks are only supported on the root agent config. Remove "experimental.tasks" from "${e.agentId}".`,
    );
  let a = mergeExternalDependencies(
      n.externalDependencies,
      i.build?.externalDependencies,
      e.resolvedExtensions.flatMap((e) => e.externalDependencies),
    ),
    o =
      a.length === 0
        ? i
        : { ...i, build: { ...i.build, externalDependencies: a } };
  return createCompiledAgentNodeManifest({
    ...(await compileAgentResources(e, t, { externalDependencies: a })),
    config: o,
  });
}
async function compileAgentResources(t, n, r = {}) {
  let s = [...(r.externalDependencies ?? [])],
    c = await Promise.all(
      t.tools.map((e) =>
        compileToolEntry(t.agentRoot, e, { externalDependencies: s }),
      ),
    ),
    l = [],
    u = [],
    d = [],
    f,
    p;
  for (let e of c)
    e.kind === `tool`
      ? l.push(e.definition)
      : e.kind === `dynamic-tool`
        ? u.push(e.definition)
        : e.kind === `workflow-tool`
          ? (f = { maxSubagents: e.maxSubagents })
          : e.kind === `web-search-tool`
            ? (p = e.provider)
            : d.push(e.name);
  let m = (
      await Promise.all(
        t.channels.map((n) =>
          compileChannelDefinition(t.agentRoot, n, { externalDependencies: s }),
        ),
      )
    ).flat(),
    h = await Promise.all(
      t.skills.map((e) =>
        compileSkillSource(t.agentRoot, e, { externalDependencies: s }),
      ),
    ),
    g = [],
    _ = [];
  for (let e of h)
    e.kind === `skill` ? g.push(e.definition) : _.push(e.definition);
  let v = await Promise.all(
      t.instructions.map((e) =>
        compileInstructionsEntry(t.agentRoot, e, { externalDependencies: s }),
      ),
    ),
    y = [],
    b = [];
  for (let e of v)
    e.kind === `instructions` ? y.push(e.definition) : b.push(e.definition);
  let x = await Promise.all(
      t.connections.map((e) =>
        compileConnectionDefinition(t.agentRoot, e, {
          externalDependencies: s,
        }),
      ),
    ),
    S = t.hooks.map((e) => compileHookEntry(e)),
    C = await Promise.all(
      t.schedules.map((e) =>
        compileScheduleDefinition(t.agentRoot, e, { externalDependencies: s }),
      ),
    ),
    w = new Set(l.map((e) => e.name)),
    T = new Set(u.map((e) => e.slug)),
    E = new Set(x.map((e) => e.connectionName)),
    D = new Set(g.map((e) => e.name)),
    O = [];
  for (let e of [...t.resolvedExtensions].sort((e, t) =>
    e.namespace.localeCompare(t.namespace),
  )) {
    let r = await compileExtensionContributions({
      mount: e,
      context: n,
      consumerAgentRoot: t.agentRoot,
      externalDependencies: s,
    });
    m.push(...r.channels);
    for (let e of r.tools) w.has(e.name) || (w.add(e.name), l.push(e));
    for (let e of r.dynamicTools) T.has(e.slug) || (T.add(e.slug), u.push(e));
    for (let e of r.connections)
      E.has(e.connectionName) || (E.add(e.connectionName), x.push(e));
    for (let e of r.skills) D.has(e.name) || (D.add(e.name), g.push(e));
    (C.push(...r.schedules),
      S.push(...r.hooks),
      _.push(...r.dynamicSkills),
      b.push(...r.dynamicInstructions),
      O.push(...r.instructions));
  }
  let k = [...y, ...O];
  return createCompiledAgentResources({
    agentRoot: t.agentRoot,
    appRoot: t.appRoot,
    channels: m,
    extensionMounts: compileExtensionMounts(t),
    connections: x,
    diagnosticsSummary: t.diagnosticsSummary,
    disabledFrameworkTools: d,
    workflowTool: f,
    webSearchProvider: p,
    dynamicSkills: _,
    dynamicTools: u,
    hooks: S,
    sandbox:
      t.sandbox === null
        ? null
        : await compileSandboxDefinition(t.agentRoot, t.sandbox, {
            externalDependencies: s,
          }),
    sandboxWorkspaces: t.sandboxWorkspaces.map((e) => ({
      logicalPath: e.logicalPath,
      rootEntries: [...e.rootEntries],
      sourceId: e.sourceId,
      sourcePath: e.sourcePath,
    })),
    schedules: C,
    dynamicInstructions: b,
    skills: g,
    instructions: k,
    tools: l,
  });
}
function compileExtensionMounts(e) {
  return e.resolvedExtensions.map((t) => {
    let n = e.extensions.find(
      (e) => mountRefNamespace(e.logicalPath) === t.namespace,
    );
    return {
      externalDependencies: [...t.externalDependencies],
      namespace: t.namespace,
      packageName: t.packageName,
      packageNamespace: packageStateNamespace(t.packageName),
      sourceRoot: t.sourceRoot,
      mountSourceId: n?.sourceId ?? `extensions/${t.namespace}`,
      mountLogicalPath: n?.logicalPath ?? `extensions/${t.namespace}`,
    };
  });
}
function mergeExternalDependencies(...e) {
  let t = new Set();
  for (let n of e) for (let e of n ?? []) t.add(e);
  return [...t];
}
export { compileAgentManifest };
