import { defineSetupIntegration } from "../types.js";
import {
  installScaffoldDependencies,
  reportOverwrittenFiles,
} from "../shared/scaffold.js";
import { ensureChannel } from "#setup/scaffold/index.js";
import { formatNodeEngineOverrideWarning } from "#setup/node-engine.js";
import { detectPackageManager } from "#setup/package-manager.js";
function reportCompetingNextConfigFiles(e, t) {
  for (let n of t ?? [])
    e.warning(
      `Found competing Next.js config at ${n}; merge any needed settings into next.config.ts and remove it before starting the preview, or Next.js may ignore the generated eve rewrite.`,
    );
}
const defaultDeps = {
  detectPackageManager,
  ensureChannel,
  installScaffoldDependencies,
};
async function prepareWebSetup(e, t = defaultDeps) {
  return {
    packageManager: (await t.detectPackageManager(e.appRoot)).kind,
    configureVercelServices: e.environment.vercel.kind === `available`,
  };
}
async function applyWebSetup(e, t, r = defaultDeps) {
  t.presenter.log.message(`Scaffolding Web Chat channel files...`);
  let i = {
      projectRoot: t.appRoot,
      kind: `web`,
      packageManager: e.packageManager,
      configureVercelServices: e.configureVercelServices,
      force: t.force,
      skipDependencyMutation: !0,
    },
    a = await r.ensureChannel(i);
  return (
    reportOverwrittenFiles(t.presenter.log, a.filesOverwritten),
    a.kind === `web` &&
      a.action !== `skipped` &&
      a.nodeEngineOverride !== void 0 &&
      t.presenter.log.warning(
        formatNodeEngineOverrideWarning(a.nodeEngineOverride),
      ),
    reportCompetingNextConfigFiles(
      t.presenter.log,
      `competingNextConfigFiles` in a ? a.competingNextConfigFiles : void 0,
    ),
    a.action === `skipped`
      ? (t.presenter.log.info(
          `Next.js project detected. Skipping Web Chat scaffolding.`,
        ),
        { facts: [] })
      : (t.presenter.log.success(`Scaffolded channel: web`),
        await r.installScaffoldDependencies({
          changed: a.packageJsonUpdated.length > 0,
          log: t.presenter.log,
          projectPath: t.appRoot,
          signal: t.signal,
        }),
        { facts: [], deploymentRequired: !0 })
  );
}
const WEB_SETUP = defineSetupIntegration({
  kind: `web`,
  label: `Web Chat`,
  hint: `Browser-based chat interface`,
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
export { WEB_SETUP, applyWebSetup, prepareWebSetup };
