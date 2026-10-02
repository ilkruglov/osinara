import { join } from "node:path";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { EXTENSION_CAPABILITY_VERSIONS } from "#compiler/extension-compatibility.js";
import { extensionUsesState } from "#internal/nitro/host/extension-state-usage.js";
async function deriveExtensionCapabilityRequirements(r) {
  let i = new Set([`extension`]),
    a = { externalDependencies: r.runtimeDependencies },
    o = collectSubagentManifests(r.manifest),
    [s, c, l, u, d] = await Promise.all([
      Promise.all(
        o.flatMap((e) =>
          e.tools.map((t) => compileToolEntry(e.agentRoot, t, a)),
        ),
      ),
      Promise.all(
        o.flatMap((e) =>
          e.skills.map((t) => compileSkillSource(e.agentRoot, t, a)),
        ),
      ),
      Promise.all(
        o.flatMap((e) =>
          e.instructions.map((n) =>
            compileInstructionsEntry(e.agentRoot, n, a),
          ),
        ),
      ),
      loadAuthoredModuleNamespace(
        join(r.sourceRoot, r.declarationModule.logicalPath),
        { externalDependencies: r.runtimeDependencies },
      ),
      extensionUsesState(r.sourceRoot),
    ]);
  (s.length > 0 && i.add(`tool`),
    s.some((e) => e.kind === `dynamic-tool`) && i.add(`dynamicTool`),
    o.some((e) => e.channels.length > 0) && i.add(`channel`),
    o.some((e) => e.connections.length > 0) && i.add(`connection`),
    o.some((e) => e.hooks.length > 0) && i.add(`hook`),
    o.some((e) => e.schedules.length > 0) && i.add(`schedule`),
    o.some((e) => e.subagents.length > 0) && i.add(`subagent`),
    c.length > 0 && i.add(`skill`),
    c.some((e) => e.kind === `dynamic-skill`) && i.add(`dynamicSkill`),
    l.length > 0 && i.add(`instructions`),
    l.some((e) => e.kind === `dynamic-instructions`) &&
      i.add(`dynamicInstructions`));
  let f = u[r.declarationModule.exportName ?? `default`];
  return (
    (typeof f == `function` || (typeof f == `object` && f)) &&
      `schema` in f &&
      f.schema !== void 0 &&
      i.add(`config`),
    d && i.add(`state`),
    Object.fromEntries(
      Object.keys(EXTENSION_CAPABILITY_VERSIONS)
        .filter((e) => i.has(e))
        .map((e) => [e, EXTENSION_CAPABILITY_VERSIONS[e]]),
    )
  );
}
function collectSubagentManifests(e) {
  return [
    e,
    ...e.subagents.flatMap((e) => collectSubagentManifests(e.manifest)),
  ];
}
export { deriveExtensionCapabilityRequirements };
