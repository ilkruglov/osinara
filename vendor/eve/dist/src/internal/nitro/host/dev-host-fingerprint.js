import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import { computeChannelRouteRegistrations } from "#internal/nitro/host/channel-routes.js";
async function computeDevelopmentHostFingerprint(t) {
  let i = t.compileResult.manifest,
    a = [i, ...i.subagents.map((e) => e.agent)],
    o = {
      agentName: i.config.name,
      bundler: {
        externalDependencies: [
          ...new Set([
            ...(i.config.build?.externalDependencies ?? []),
            ...i.subagents.flatMap((e) =>
              e.configResolver === void 0
                ? (e.agent.config.build?.externalDependencies ?? [])
                : (e.configResolver.build?.externalDependencies ?? []),
            ),
          ]),
        ].sort((e, t) => e.localeCompare(t)),
        extensionScopes: a
          .flatMap((e) => e.extensionMounts)
          .map((e) => ({
            packageNamespace: e.packageNamespace,
            sourceRoot: e.sourceRoot,
          }))
          .sort((e, t) => e.sourceRoot.localeCompare(t.sourceRoot)),
        sandboxBackends: [
          ...new Set(
            a.map((e) => e.sandbox?.backendName).filter((e) => e !== void 0),
          ),
        ].sort((e, t) => e.localeCompare(t)),
      },
      channels: computeChannelRouteRegistrations(t),
      environment: readDevelopmentEnvironmentHostValues(t.appRoot),
      instrumentation: await readInstrumentationSource(t),
      workflow: {
        enabled: a.some((e) => e.workflowTool !== void 0),
        world: i.config.experimental?.workflow?.world ?? `local`,
      },
    };
  return createHash(`sha256`).update(JSON.stringify(o)).digest(`hex`);
}
async function readInstrumentationSource(e) {
  let n = e.compiledArtifacts.instrumentationSourcePaths,
    r = e.compiledArtifacts.instrumentationLayout;
  if (n === void 0 || r === void 0) return null;
  let i = await Promise.all(n.map(async (e) => await readFile(e, `utf8`)));
  return {
    kind: r.kind,
    modules: i.map((e, t) => ({
      slot: r.kind === `directory` ? (r.slots[t] ?? null) : null,
      source: e,
    })),
  };
}
export { computeDevelopmentHostFingerprint };
