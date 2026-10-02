import { join, resolve } from "node:path";
import {
  SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS,
  classifyAgentRootEntry,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import { createDiscoverErrorDiagnostic } from "#discover/diagnostics.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import {
  createAgentSourceManifest,
  createModuleSourceRef,
} from "#discover/manifest.js";
import {
  DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
  DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
  locateExtensionMount,
  mountNamespace,
} from "#discover/extensions.js";
import {
  DISCOVER_CHANNELS_DIRECTORY_INVALID,
  DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
  DISCOVER_HOOKS_DIRECTORY_INVALID,
  DISCOVER_TOOLS_DIRECTORY_INVALID,
  createChannelNameDiagnostic,
  createExtensionNameDiagnostic,
  createHookNameDiagnostic,
  createToolNameDiagnostic,
  createUnsupportedRootDirectoryDiagnostics,
  discoverFlatModuleSource,
  discoverInstructionsSource,
  discoverNamedSourceDirectory,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { discoverConnectionSources } from "#discover/connections.js";
import { discoverSubagents } from "#discover/discover-subagent.js";
import { discoverLibSources } from "#discover/lib.js";
import { discoverSandboxSource } from "#discover/sandbox.js";
import { discoverScheduleSources } from "#discover/schedules.js";
import { discoverSkills } from "#discover/skills.js";
import { stripNpmPackageScope } from "#shared/package-name.js";
async function discoverAgent(n) {
  let i = n.source ?? createDiskProjectSource(),
    c = resolve(n.appRoot),
    u = resolve(n.agentRoot),
    d = n.role ?? `agent`,
    p = [],
    h = await tryReadPackageJsonName(i, c),
    g = await readSortedDirectoryEntries(i, u);
  p.push(
    ...createUnsupportedRootDirectoryDiagnostics({
      classifyEntry: classifyAgentRootEntry,
      createUnsupportedDirectoryMessage(e) {
        return `Ignoring unsupported directory "${e}/" in the agent root.`;
      },
      rootEntries: g,
      rootPath: u,
    }),
  );
  let _ = await discoverInstructionsSource({
    rootEntries: g,
    rootPath: u,
    source: i,
    required: d !== `extension`,
  });
  p.push(..._.diagnostics);
  let v = discoverFlatModuleSource({
    rootEntries: g,
    rootPath: u,
    slotName: `agent`,
  });
  p.push(...v.diagnostics);
  let y = await discoverNamedSourceDirectory({
    directoryName: `channels`,
    invalidDirectoryCode: DISCOVER_CHANNELS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(u, `channels`)}" to be a directory of authored channels.`,
    recursive: !0,
    rootEntries: g,
    rootPath: u,
    source: i,
    validateSegment: createChannelNameDiagnostic,
  });
  p.push(...y.diagnostics);
  let b = await discoverLibSources({ agentRoot: u, rootEntries: g, source: i });
  p.push(...b.diagnostics);
  let x = await discoverScheduleSources({
    agentRoot: u,
    rootEntries: g,
    source: i,
  });
  p.push(...x.diagnostics);
  let S = await discoverConnectionSources({
    rootEntries: g,
    rootPath: u,
    source: i,
  });
  p.push(...S.diagnostics);
  let C = await discoverSandboxSource({
    rootEntries: g,
    rootPath: u,
    source: i,
  });
  (p.push(...C.diagnostics),
    d === `extension` &&
      (v.module !== void 0 &&
        p.push(
          createDiscoverErrorDiagnostic({
            code: DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED,
            message: `An extension may not declare agent config (agent.ts) — model, limits, and sandbox are the consuming agent's to own.`,
            sourcePath: join(u, v.module.logicalPath),
          }),
        ),
      C.sandbox !== null &&
        p.push(
          createDiscoverErrorDiagnostic({
            code: DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED,
            message: `An extension may not declare a sandbox — it is the consuming agent's to own.`,
            sourcePath: join(u, C.sandbox.logicalPath),
          }),
        )));
  let w = await discoverNamedSourceDirectory({
    directoryName: `tools`,
    invalidDirectoryCode: DISCOVER_TOOLS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(u, `tools`)}" to be a directory of authored tools.`,
    recursive: !0,
    rootEntries: g,
    rootPath: u,
    source: i,
    validateSegment: createToolNameDiagnostic,
  });
  p.push(...w.diagnostics);
  let T = await discoverNamedSourceDirectory({
    directoryName: `hooks`,
    invalidDirectoryCode: DISCOVER_HOOKS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(u, `hooks`)}" to be a directory of authored hooks.`,
    recursive: !0,
    rootEntries: g,
    rootPath: u,
    source: i,
    validateSegment: createHookNameDiagnostic,
  });
  p.push(...T.diagnostics);
  let E = await discoverNamedSourceDirectory({
    directoryName: `extensions`,
    invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
    invalidDirectoryMessage: `Expected "${join(u, `extensions`)}" to be a directory of extension mounts.`,
    recursive: !1,
    rootEntries: g,
    rootPath: u,
    source: i,
    validateSegment: createExtensionNameDiagnostic,
  });
  p.push(...E.diagnostics);
  let D = await discoverSkills({ agentRoot: u, source: i });
  p.push(...D.diagnostics);
  let O = await discoverSubagents({ agentRoot: u, appRoot: c, source: i });
  p.push(...O.diagnostics);
  let k = await collectExtensionMounts({
    agentRoot: u,
    fileMounts: E.sources,
    rootEntries: g,
    source: i,
  });
  (p.push(...k.diagnostics),
    p.push(
      ...detectRootNamespaceCollisions({
        agentRoot: u,
        namespaces: k.mounts.map((e) => e.namespace),
        sources: [
          ...w.sources,
          ...S.connections,
          ...D.skills,
          ...x.schedules,
          ...O.subagents,
        ],
      }),
    ));
  let A = [];
  if (d !== `agent`)
    for (let t of k.mounts)
      p.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
          message: `"${t.mountRef.logicalPath}" mounts an extension from inside an extension, which is not supported yet. Extensions cannot mount other extensions; remove the "extensions/" slot.`,
          sourcePath: join(u, t.mountRef.logicalPath),
        }),
      );
  else {
    let e = await resolveExtensionMounts({
      agentRoot: u,
      appRoot: c,
      mounts: k.mounts,
      source: i,
    });
    (p.push(...e.diagnostics), (A = e.mounts));
  }
  let j = {
    agentRoot: u,
    appRoot: c,
    channels: y.sources,
    connections: S.connections,
    packageName: h,
    diagnostics: p,
    extensions: k.mounts.map((e) => e.mountRef),
    resolvedExtensions: A,
    hooks: T.sources,
    lib: b.lib,
    instructions: _.instructions,
    sandbox: C.sandbox,
    sandboxWorkspaces: C.sandboxWorkspace === null ? [] : [C.sandboxWorkspace],
    schedules: x.schedules,
    skills: D.skills,
    tools: w.sources,
    subagents: O.subagents,
  };
  return (
    v.module !== void 0 && (j.configModule = v.module),
    { diagnostics: p, manifest: createAgentSourceManifest(j) }
  );
}
async function resolveExtensionMounts(e) {
  let t = [],
    n = [];
  for (let r of e.mounts) {
    let i = await locateExtensionMount({
      source: e.source,
      agentRoot: e.agentRoot,
      appRoot: e.appRoot,
      mount: r.mountRef,
      namespace: r.namespace,
    });
    if ((t.push(...i.diagnostics), i.location === void 0)) continue;
    let a = await discoverAgent({
      agentRoot: i.location.sourceRoot,
      appRoot: i.location.packageRoot,
      source: e.source,
      role: `extension`,
    });
    t.push(...a.diagnostics);
    let o;
    if (r.overridesRoot !== void 0) {
      let n = await discoverAgent({
        agentRoot: r.overridesRoot,
        appRoot: e.appRoot,
        source: e.source,
        role: `extension`,
      });
      (t.push(...n.diagnostics), (o = n.manifest));
    }
    n.push({
      namespace: i.location.namespace,
      specifier: i.location.specifier,
      packageName: i.location.packageName,
      packageRoot: i.location.packageRoot,
      sourceRoot: i.location.sourceRoot,
      manifest: a.manifest,
      externalDependencies: i.location.externalDependencies,
      overrides: o,
    });
  }
  return { diagnostics: t, mounts: n };
}
async function discoverExtensionMountDeclarations(n) {
  let r = n.source ?? createDiskProjectSource(),
    i = resolve(n.agentRoot),
    a = await readSortedDirectoryEntries(r, i),
    s = await discoverNamedSourceDirectory({
      directoryName: `extensions`,
      invalidDirectoryCode: DISCOVER_EXTENSIONS_DIRECTORY_INVALID,
      invalidDirectoryMessage: `Expected "${join(i, `extensions`)}" to be a directory of extension mounts.`,
      recursive: !1,
      rootEntries: a,
      rootPath: i,
      source: r,
      validateSegment: createExtensionNameDiagnostic,
    }),
    c = await collectExtensionMounts({
      agentRoot: i,
      fileMounts: s.sources,
      rootEntries: a,
      source: r,
    });
  return {
    diagnostics: [...s.diagnostics, ...c.diagnostics],
    mounts: c.mounts,
  };
}
async function collectExtensionMounts(t) {
  let n = [],
    r = join(t.agentRoot, `extensions`),
    o = t.fileMounts.map((e) => ({
      namespace: mountNamespace(e.logicalPath),
      mountRef: e,
    })),
    s = new Set(o.map((e) => e.namespace)),
    l = t.rootEntries.find((e) => e.name === `extensions`),
    f = [],
    p = new Set();
  if (l?.isDirectory() === !0) {
    let o = await readSortedDirectoryEntries(t.source, r);
    for (let l of o) {
      if (!l.isDirectory()) continue;
      let o = l.name,
        u = join(r, o),
        m = createExtensionNameDiagnostic(o, u);
      if (m !== null) {
        n.push(m);
        continue;
      }
      let h = discoverFlatModuleSource({
        rootEntries: await readSortedDirectoryEntries(t.source, u),
        rootPath: u,
        slotName: `extension`,
      });
      if ((n.push(...h.diagnostics), h.module === void 0)) {
        n.push(
          createDiscoverErrorDiagnostic({
            code: DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
            message: `Extension mount directory "extensions/${o}/" must declare its mount in "extension.ts" (or another supported module extension).`,
            sourcePath: u,
          }),
        );
        continue;
      }
      (s.has(o) && p.add(o),
        f.push({
          namespace: o,
          mountRef: createModuleSourceRef({
            logicalPath: normalizeLogicalPath(
              join(`extensions`, o, h.module.logicalPath),
            ),
          }),
          overridesRoot: u,
        }));
    }
  }
  for (let e of p)
    n.push(
      createDiscoverErrorDiagnostic({
        code: DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
        message: `Extension namespace "${e}" is claimed by both a file mount ("extensions/${e}.ts") and a directory mount ("extensions/${e}/"). Keep only one.`,
        sourcePath: r,
      }),
    );
  return {
    diagnostics: n,
    mounts: [...o, ...f].filter((e) => !p.has(e.namespace)),
  };
}
function detectRootNamespaceCollisions(t) {
  if (t.namespaces.length === 0) return [];
  let n = [];
  for (let r of t.sources) {
    let i = rootContributionName(r.logicalPath),
      o = t.namespaces.find((e) => i.startsWith(`${e}__`));
    o !== void 0 &&
      n.push(
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
          message: `"${r.logicalPath}" uses the "${o}__" prefix reserved for the mounted extension "${o}". Override an extension's contributions inside its mount directory ("extensions/${o}/…"), not at the agent root.`,
          sourcePath: join(t.agentRoot, r.logicalPath),
        }),
      );
  }
  return n;
}
function rootContributionName(e) {
  let t = e.slice(e.indexOf(`/`) + 1),
    r = t.split(`/`)[0] ?? t;
  for (let e of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS)
    if (r.toLowerCase().endsWith(e)) return r.slice(0, r.length - e.length);
  return r;
}
async function tryReadPackageJsonName(t, n) {
  try {
    let r = join(n, `package.json`),
      i = JSON.parse(await t.readTextFile(r)).name;
    return typeof i != `string` || i.length === 0
      ? void 0
      : stripNpmPackageScope(i);
  } catch {
    return;
  }
}
export {
  detectRootNamespaceCollisions,
  discoverAgent,
  discoverExtensionMountDeclarations,
  resolveExtensionMounts,
};
