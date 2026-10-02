import { createLogger } from "#internal/logging.js";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
const INSTRUMENTATION_EXTENSIONS = [`.ts`, `.mts`, `.js`, `.mjs`],
  INSTRUMENTATION_DIRECTORY = `instrumentation`,
  PROVIDERS_FLAG = `experimental.instrumentationProviders`,
  log = createLogger(`internal.instrumentation-layout`);
function resolveInstrumentationLayout(e) {
  let r = resolveInstrumentationFile(e.agentRoot),
    a = join(e.agentRoot, INSTRUMENTATION_DIRECTORY),
    s = existsSync(a) && statSync(a).isDirectory();
  if (!e.providersEnabled)
    return (
      s &&
        log.warn(
          `ignoring instrumentation provider directory because providers are off`,
          { agentRoot: e.agentRoot, flag: PROVIDERS_FLAG },
        ),
      r === void 0 ? void 0 : { kind: `file`, modulePath: r }
    );
  if (r !== void 0)
    throw Error(
      `Found "${r}", but \`${PROVIDERS_FLAG}\` is on. Move it into the "${INSTRUMENTATION_DIRECTORY}/" directory as one file per provider.`,
    );
  return s
    ? {
        kind: `directory`,
        modulePathsBySlot: collectInstrumentationProviderModules(a),
      }
    : { kind: `directory`, modulePathsBySlot: {} };
}
function collectInstrumentationProviderModules(e) {
  let n = new Map();
  for (let i of readdirSync(e, { withFileTypes: !0 })) {
    if (!i.isFile()) continue;
    let r = INSTRUMENTATION_EXTENSIONS.find((e) => i.name.endsWith(e));
    if (r === void 0) continue;
    let o = i.name.slice(0, -r.length);
    if (o !== ``) {
      if (n.get(o) !== void 0)
        throw Error(
          `Two files declare the "${o}" instrumentation provider in "${e}". Keep one of them.`,
        );
      n.set(o, join(e, i.name));
    }
  }
  return Object.fromEntries([...n].sort(([e], [t]) => e.localeCompare(t)));
}
function resolveInstrumentationFile(e) {
  for (let r of INSTRUMENTATION_EXTENSIONS) {
    let i = join(e, `${INSTRUMENTATION_DIRECTORY}${r}`);
    if (existsSync(i)) return i;
  }
}
export { resolveInstrumentationLayout };
