import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { runVercelEnvPull } from "#setup/run-vercel-link.js";
import { runVercel } from "#setup/primitives/index.js";
const defaultDependencies = { isEveProject, runVercel, runVercelEnvPull };
function isNonInteractiveProjectCommand(e) {
  return e.nonInteractive === !0;
}
async function runNonInteractiveLink(t) {
  let { appRoot: n, logger: r, options: i } = t,
    a = t.dependencies ?? defaultDependencies;
  if (!(await a.isEveProject(n)))
    return (r.error(NOT_AN_AGENT_MESSAGE), (process.exitCode = 1), !1);
  if (i.project === void 0)
    return (
      r.error(
        "`eve link --non-interactive` requires `--project <name-or-id>`.",
      ),
      (process.exitCode = 1),
      !1
    );
  let o = [
    `link`,
    `--project`,
    i.project,
    ...(i.team === void 0 ? [] : [`--team`, i.team]),
    `--yes`,
  ];
  return (await a.runVercel(o, { cwd: n, nonInteractive: !0 }))
    ? (await a.runVercelEnvPull(n, void 0, void 0, !0))
      ? (r.log(`Project linked.`), !0)
      : (r.error(
          `Vercel project linked, but pulling environment variables did not complete.`,
        ),
        (process.exitCode = 1),
        !1)
    : ((process.exitCode = 1), !1);
}
export { isNonInteractiveProjectCommand, runNonInteractiveLink };
