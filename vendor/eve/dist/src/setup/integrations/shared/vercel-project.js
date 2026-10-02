import { SetupPrerequisiteRequired } from "./prerequisite.js";
import { readProjectLink } from "#setup/project-resolution.js";
const defaultDeps = { readProjectLink };
async function resolveIntegrationVercelProject(e) {
  e.signal?.throwIfAborted();
  let t = await (e.deps ?? defaultDeps).readProjectLink(e.appRoot);
  if (t !== void 0) return t;
  throw new SetupPrerequisiteRequired({
    kind: `command`,
    code: `vercel-project-link`,
    message: `Vercel Connect setup requires a linked Vercel project. Run \`eve link\`, then retry ${e.integration} setup.`,
    command: `eve link`,
  });
}
export { resolveIntegrationVercelProject };
