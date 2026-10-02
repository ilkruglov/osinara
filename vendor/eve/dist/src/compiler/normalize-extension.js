import { join, relative } from "node:path";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { createPathDerivedSourceId } from "#discover/manifest.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
async function compileExtensionContributions(e) {
  let { mount: t, consumerAgentRoot: n } = e,
    r = { externalDependencies: e.externalDependencies },
    i = await composeManifestContributions({
      manifest: t.manifest,
      namespace: t.namespace,
      consumerAgentRoot: n,
      options: r,
      sourceIdScope: `ext:${t.namespace}`,
      role: `extension`,
    });
  if (t.overrides === void 0) return i.contributions;
  let a = await composeManifestContributions({
    manifest: t.overrides,
    namespace: t.namespace,
    consumerAgentRoot: n,
    options: r,
    sourceIdScope: `ext-override:${t.namespace}`,
    role: `override`,
  });
  return applyOverrideDisables({
    merged: mergeContributions(a.contributions, i.contributions),
    disables: a.disabledToolTargets,
    extensionToolNames: new Set(i.contributions.tools.map((e) => e.name)),
    extensionDynamicToolSlugs: new Set(
      i.contributions.dynamicTools.map((e) => e.slug),
    ),
    namespace: t.namespace,
  });
}
function composeExtensionSubagentSources(e) {
  let t = scopeExtensionSubagents({
    consumerAgentRoot: e.consumerAgentRoot,
    manifest: e.mount.manifest,
    namespace: e.mount.namespace,
    sourceIdScope: `ext:${e.mount.namespace}`,
    sourceRoot: e.mount.sourceRoot,
  });
  return e.mount.overrides === void 0
    ? t
    : mergeExtensionSubagentSources(
        scopeExtensionSubagents({
          consumerAgentRoot: e.consumerAgentRoot,
          manifest: e.mount.overrides,
          namespace: e.mount.namespace,
          sourceIdScope: `ext-override:${e.mount.namespace}`,
          sourceRoot: e.mount.overrides.agentRoot,
        }),
        t,
      );
}
function composeAgentSubagentSources(e) {
  return [
    ...e.subagents,
    ...[...e.resolvedExtensions]
      .sort((e, t) => e.namespace.localeCompare(t.namespace))
      .flatMap((t) =>
        composeExtensionSubagentSources({
          consumerAgentRoot: e.agentRoot,
          mount: t,
        }),
      ),
  ];
}
function mergeExtensionSubagentSources(e, t) {
  return dedupeBy([...e, ...t], (e) => e.subagentId);
}
function scopeExtensionSubagents(e) {
  return e.manifest.subagents.map((n) => ({
    ...scopeExtensionSubagentSource(n, e.sourceRoot, e.sourceIdScope),
    logicalPath: relative(e.consumerAgentRoot, n.entryPath).replaceAll(
      `\\`,
      `/`,
    ),
    subagentId: `${e.namespace}__${n.subagentId}`,
  }));
}
function scopeExtensionSubagentSource(e, t, n) {
  return {
    ...e,
    manifest: scopeExtensionSubagentManifest(e.manifest, t, n),
    sourceId: scopeExtensionSourceId(t, e.entryPath, n),
  };
}
function scopeExtensionSubagentManifest(t, n, r) {
  let scopeRef = (i) => ({
    ...i,
    sourceId: scopeExtensionSourceId(n, join(t.agentRoot, i.logicalPath), r),
  });
  return {
    ...t,
    channels: t.channels.map(scopeRef),
    connections: t.connections.map(scopeRef),
    ...(t.configModule === void 0
      ? {}
      : { configModule: scopeRef(t.configModule) }),
    extensions: t.extensions.map(scopeRef),
    hooks: t.hooks.map(scopeRef),
    instructions: t.instructions.map(scopeRef),
    lib: t.lib.map(scopeRef),
    sandbox: t.sandbox === null ? null : scopeRef(t.sandbox),
    sandboxWorkspaces: t.sandboxWorkspaces.map(scopeRef),
    schedules: t.schedules.map(scopeRef),
    skills: t.skills.map(scopeRef),
    subagents: t.subagents.map((e) => scopeExtensionSubagentSource(e, n, r)),
    tools: t.tools.map(scopeRef),
  };
}
function scopeExtensionSourceId(e, n, i) {
  return `${i}:${createPathDerivedSourceId(relative(e, n).replaceAll(`\\`, `/`))}`;
}
function applyOverrideDisables(e) {
  if (e.disables.length === 0) return e.merged;
  let t = e.namespace.length + 2,
    n = new Set();
  for (let r of e.disables) {
    if (
      !e.extensionToolNames.has(r.name) &&
      !e.extensionDynamicToolSlugs.has(r.name)
    ) {
      let n = [...e.extensionToolNames, ...e.extensionDynamicToolSlugs]
        .map((e) => e.slice(t))
        .sort();
      throw Error(
        `The override "agent/extensions/${e.namespace}/${r.logicalPath}" calls disableTool(), but the "${e.namespace}" extension contributes no tool named "${r.name.slice(t)}". It contributes: ${n.length > 0 ? n.join(`, `) : `(no tools)`}.`,
      );
    }
    n.add(r.name);
  }
  return {
    ...e.merged,
    tools: e.merged.tools.filter((e) => !n.has(e.name)),
    dynamicTools: e.merged.dynamicTools.filter((e) => !n.has(e.slug)),
  };
}
async function composeManifestContributions(r) {
  let {
      manifest: o,
      namespace: s,
      consumerAgentRoot: c,
      options: l,
      sourceIdScope: u,
      role: d,
    } = r,
    f = o.agentRoot,
    p = `${s}__`,
    scopeSourceId = (e) => `${u}:${e}`,
    rebase = (n) => relative(c, join(f, n)).replaceAll(`\\`, `/`),
    m = (
      await Promise.all(
        o.channels.map((e) => compileChannelDefinition(f, e, l)),
      )
    )
      .flat()
      .map((e) =>
        e.kind === `disabled`
          ? { ...e, name: `${p}${e.name}`, logicalPath: rebase(e.logicalPath) }
          : {
              ...e,
              name: `${p}${e.name}`,
              sourceId: scopeSourceId(e.sourceId),
              logicalPath: rebase(e.logicalPath),
            },
      ),
    h = [],
    g = [],
    _ = [];
  for (let e of o.tools) {
    let t = await compileToolEntry(f, e, l);
    if (t.kind === `tool`)
      h.push({
        ...t.definition,
        name: `${p}${t.definition.name}`,
        sourceId: scopeSourceId(t.definition.sourceId),
        logicalPath: rebase(t.definition.logicalPath),
      });
    else if (t.kind === `dynamic-tool`)
      g.push({
        ...t.definition,
        slug: `${p}${t.definition.slug}`,
        extensionNamespace: s,
        sourceId: scopeSourceId(t.definition.sourceId),
        logicalPath: rebase(t.definition.logicalPath),
      });
    else if (t.kind === `workflow-tool`)
      throw Error(
        `${describeExtensionSource(d, s, e.logicalPath)} enables the Workflow tool, but the Workflow tool is the consuming agent's to enable, not an extension's. Remove it.`,
      );
    else if (t.kind === `web-search-tool`)
      throw Error(
        `${describeExtensionSource(d, s, e.logicalPath)} configures web search, but the web search provider is the consuming agent's to configure, not an extension's. Remove it.`,
      );
    else if (d === `extension`)
      throw Error(
        `${describeExtensionSource(d, s, e.logicalPath)} calls disableTool(), but an extension cannot disable framework tools — that is the consuming agent's to own. Remove it.`,
      );
    else _.push({ name: `${p}${t.name}`, logicalPath: e.logicalPath });
  }
  let v = o.hooks.map((e) => {
      let t = compileHookEntry(e);
      return {
        ...t,
        slug: `${p}${t.slug}`,
        sourceId: scopeSourceId(t.sourceId),
        logicalPath: rebase(t.logicalPath),
      };
    }),
    y = [],
    b = [];
  for (let e of o.skills) {
    let t = await compileSkillSource(f, e, l);
    t.kind === `skill`
      ? y.push({
          ...t.definition,
          name: `${p}${t.definition.name}`,
          sourceId: scopeSourceId(t.definition.sourceId),
          logicalPath: rebase(t.definition.logicalPath),
        })
      : b.push({
          ...t.definition,
          slug: `${p}${t.definition.slug}`,
          extensionNamespace: s,
          sourceId: scopeSourceId(t.definition.sourceId),
          logicalPath: rebase(t.definition.logicalPath),
        });
  }
  let x = (
      await Promise.all(
        o.connections.map((e) => compileConnectionDefinition(f, e, l)),
      )
    ).map((e) => ({
      ...e,
      connectionName: `${p}${e.connectionName}`,
      sourceId: scopeSourceId(e.sourceId),
      logicalPath: rebase(e.logicalPath),
    })),
    S = [],
    C = [];
  for (let e of o.instructions) {
    let t = await compileInstructionsEntry(f, e, l);
    t.kind === `instructions`
      ? C.push({
          ...t.definition,
          sourceId: scopeSourceId(t.definition.sourceId),
          logicalPath: rebase(t.definition.logicalPath),
        })
      : S.push({
          ...t.definition,
          slug: `${p}${t.definition.slug}`,
          sourceId: scopeSourceId(t.definition.sourceId),
          logicalPath: rebase(t.definition.logicalPath),
        });
  }
  return {
    contributions: {
      channels: m,
      tools: h,
      dynamicTools: g,
      hooks: v,
      skills: y,
      dynamicSkills: b,
      dynamicInstructions: S,
      connections: x,
      instructions: C,
      schedules: await Promise.all(
        o.schedules.map(async (e) => {
          let t = await compileScheduleDefinition(f, e, l);
          return {
            ...t,
            name: `${p}${t.name}`,
            sourceId: scopeSourceId(t.sourceId),
            logicalPath: rebase(t.logicalPath),
          };
        }),
      ),
    },
    disabledToolTargets: _,
  };
}
function describeExtensionSource(e, t, n) {
  return e === `override`
    ? `The override "agent/extensions/${t}/${n}"`
    : `The "${t}" extension's "${n}"`;
}
function mergeContributions(e, t) {
  let n = new Set(e.channels.map((e) => e.name));
  return {
    channels: [...e.channels, ...t.channels.filter((e) => !n.has(e.name))],
    tools: dedupeBy([...e.tools, ...t.tools], (e) => e.name),
    dynamicTools: dedupeBy(
      [...e.dynamicTools, ...t.dynamicTools],
      (e) => e.slug,
    ),
    connections: dedupeBy(
      [...e.connections, ...t.connections],
      (e) => e.connectionName,
    ),
    skills: dedupeBy([...e.skills, ...t.skills], (e) => e.name),
    schedules: dedupeBy([...e.schedules, ...t.schedules], (e) => e.name),
    hooks: [...e.hooks, ...t.hooks],
    dynamicSkills: [...e.dynamicSkills, ...t.dynamicSkills],
    dynamicInstructions: [...e.dynamicInstructions, ...t.dynamicInstructions],
    instructions: [...e.instructions, ...t.instructions],
  };
}
function dedupeBy(e, t) {
  let n = new Set(),
    r = [];
  for (let i of e) {
    let e = t(i);
    n.has(e) || (n.add(e), r.push(i));
  }
  return r;
}
export {
  applyOverrideDisables,
  compileExtensionContributions,
  composeAgentSubagentSources,
  composeExtensionSubagentSources,
  mergeContributions,
  mergeExtensionSubagentSources,
};
