import { hasInteractiveTerminal } from "./preconditions.js";
import {
  isNonInteractiveProjectCommand,
  runNonInteractiveLink,
} from "./vercel-non-interactive.js";
import { createPrompter } from "#setup/prompter.js";
import { runLinkFlow } from "#setup/flows/link.js";
const defaultDependencies = { hasInteractiveTerminal };
async function runLinkCommand(e, n, r = defaultDependencies, i = {}) {
  if (isNonInteractiveProjectCommand(i)) {
    await runNonInteractiveLink({ logger: e, appRoot: n, options: i });
    return;
  }
  if (!r.hasInteractiveTerminal()) {
    (e.error(
      "`eve link` needs an interactive terminal to pick the team and project. Name the project instead: `eve link --project <name-or-id> --non-interactive`.",
    ),
      (process.exitCode = 1));
    return;
  }
  let a = r.createPrompter?.() ?? createPrompter();
  a.intro(`Link your eve agent to Vercel`);
  try {
    let e = await runLinkFlow({
      appRoot: n,
      prompter: a,
      projectSelection: `create-or-link`,
      deps: r.flowDeps,
    });
    a.outro(e.kind === `cancelled` ? `Cancelled.` : `Project linked.`);
  } catch (t) {
    (e.error(t instanceof Error ? t.message : String(t)),
      (process.exitCode = 1));
  }
}
export { runLinkCommand };
