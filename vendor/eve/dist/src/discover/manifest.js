import { basename, relative, resolve } from "node:path";
import { normalizeLogicalPath } from "#discover/filesystem.js";
import { summarizeDiscoverDiagnostics } from "#discover/diagnostics.js";
const AGENT_SOURCE_MANIFEST_KIND = `eve-agent-discovery-manifest`,
  AGENT_SOURCE_MANIFEST_VERSION = 13;
function createAgentSourceManifest(e) {
  let t = resolve(e.appRoot),
    r = resolve(e.agentRoot),
    o = {
      agentId: e.agentId ?? deriveAgentIdFromRoots(t, r, e.packageName),
      agentRoot: r,
      appRoot: t,
      channels: [...(e.channels ?? [])],
      connections: [...(e.connections ?? [])],
      diagnosticsSummary: summarizeDiscoverDiagnostics(e.diagnostics ?? []),
      extensions: [...(e.extensions ?? [])],
      resolvedExtensions: [...(e.resolvedExtensions ?? [])],
      hooks: [...(e.hooks ?? [])],
      instructions: [...(e.instructions ?? [])],
      lib: [...(e.lib ?? [])],
      kind: AGENT_SOURCE_MANIFEST_KIND,
      sandbox: e.sandbox ?? null,
      sandboxWorkspaces: [...(e.sandboxWorkspaces ?? [])],
      schedules: [...(e.schedules ?? [])],
      skills: [...(e.skills ?? [])],
      tools: [...(e.tools ?? [])],
      version: 13,
      subagents: [...(e.subagents ?? [])],
    };
  return (e.configModule !== void 0 && (o.configModule = e.configModule), o);
}
function deriveAgentIdFromRoots(n, i, a) {
  let o = normalizeLogicalPath(relative(n, i));
  return o === `` || o === `.` || o === `agent`
    ? (a ?? basename(n))
    : basename(i);
}
function createPathDerivedSourceId(e) {
  return normalizeLogicalPath(e);
}
function createModuleSourceRef(e) {
  let t = normalizeLogicalPath(e.logicalPath),
    n = {
      sourceKind: `module`,
      logicalPath: t,
      sourceId: e.sourceId ?? createPathDerivedSourceId(t),
    };
  return (e.exportName !== void 0 && (n.exportName = e.exportName), n);
}
function createConnectionSourceRef(e) {
  return { ...createModuleSourceRef(e), connectionName: e.connectionName };
}
function createLocalSubagentSourceRef(e) {
  let t = normalizeLogicalPath(e.logicalPath);
  return {
    entryPath: e.entryPath,
    logicalPath: t,
    manifest: e.manifest,
    rootPath: e.rootPath,
    sourceId: e.sourceId ?? createPathDerivedSourceId(t),
    subagentId: e.subagentId,
  };
}
function createSkillPackageSourceRef(e) {
  return {
    assetsPath: e.assetsPath,
    description: e.description,
    license: e.license,
    logicalPath: normalizeLogicalPath(e.logicalPath),
    markdown: e.markdown,
    metadata: e.metadata === void 0 ? void 0 : { ...e.metadata },
    name: e.name,
    referencesPath: e.referencesPath,
    rootPath: e.rootPath,
    scriptsPath: e.scriptsPath,
    skillFilePath: e.skillFilePath,
    skillId: e.skillId,
    sourceId: e.sourceId,
    sourceKind: `skill-package`,
  };
}
export {
  AGENT_SOURCE_MANIFEST_KIND,
  AGENT_SOURCE_MANIFEST_VERSION,
  createAgentSourceManifest,
  createConnectionSourceRef,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
  createPathDerivedSourceId,
  createSkillPackageSourceRef,
  deriveAgentIdFromRoots,
};
