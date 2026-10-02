import { createSetupContexts } from "./shared/ui.js";
import { setupIntegration } from "./registry.js";
import {
  describeIntegrationSetupEnvironment,
  integrationSetupEnvironment,
} from "./shared/environment.js";
import { resolveIntegrationVercelProject } from "./shared/vercel-project.js";
import {
  detectDeployment,
  projectResolutionFromDeployment,
} from "#setup/project-resolution.js";
import { interactiveAsker } from "#setup/ask.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";
const defaultDeps = { detectDeployment, getVercelAuthStatus };
async function runIntegrationSetup(t, n, r = defaultDeps) {
  let i = setupIntegration(t);
  (n.prompter.intro(`Set up ${i.label}`),
    n.prompter.log.message(`Checking Vercel setup...`));
  let [a, o] = await Promise.all([
      r.detectDeployment(n.appRoot, { signal: n.signal }),
      r.getVercelAuthStatus(n.appRoot, { signal: n.signal }),
    ]),
    s = integrationSetupEnvironment(o, projectResolutionFromDeployment(a));
  return (
    n.prompter.log.info(describeIntegrationSetupEnvironment(s)),
    i.run(
      createSetupContexts({
        appRoot: n.appRoot,
        asker: n.asker ?? interactiveAsker(n.prompter),
        environment: s,
        prompter: n.prompter,
        resolveVercelProject:
          n.resolveVercelProject ??
          ((e) =>
            resolveIntegrationVercelProject({
              appRoot: n.appRoot,
              integration: e,
              signal: n.signal,
            })),
        signal: n.signal,
        force: n.force,
        beginExternalAction: n.beginExternalAction,
      }),
    )
  );
}
export { runIntegrationSetup };
