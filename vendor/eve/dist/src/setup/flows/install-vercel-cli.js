import { withSpinner } from "../with-spinner.js";
import {
  resultSucceeded,
  runVercel,
  spawnPackageManager,
} from "#setup/primitives/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";
import { createPromptCommandOutput } from "#setup/cli/index.js";
const defaultDeps = {
  getVercelAuthStatus,
  detectPackageManager,
  runVercel,
  spawnPackageManager,
};
function globalInstallArguments(e) {
  switch (e) {
    case `npm`:
      return [`install`, `-g`, `vercel@latest`];
    case `yarn`:
      return [`global`, `add`, `vercel@latest`];
    case `pnpm`:
    case `bun`:
      return [`add`, `-g`, `vercel@latest`];
  }
}
function summarizeUpgradeFailure(e) {
  let t = e
      .map((e) => e.trim().replace(/\s+/gu, ` `))
      .filter(
        (e) =>
          e !== `` &&
          e !== `}` &&
          !e.startsWith(`at `) &&
          !/^vercel upgrade exited with code \d+\.$/u.test(e),
      ),
    n =
      t.find((e) =>
        /^(?:error\b|err_|.*\b(?:cannot|failed|could not)\b)/iu.test(e),
      ) ?? t.at(-1);
  if (n !== void 0) return n.length <= 240 ? n : `${n.slice(0, 239)}…`;
}
async function runInstallVercelCliFlow(n) {
  let { appRoot: r, prompter: i, signal: a } = n,
    o = { ...defaultDeps, ...n.deps },
    s = createPromptCommandOutput(i.log),
    probe = async () =>
      (await o.getVercelAuthStatus(r, { signal: a })) !== `cli-missing`;
  if (
    !n.upgrade &&
    (await withSpinner(i, `Checking for the Vercel CLI…`, probe))
  )
    return (a?.throwIfAborted(), { kind: `already` });
  a?.throwIfAborted();
  let c, l;
  if (n.upgrade) {
    let t = [];
    c = await withSpinner(i, `Upgrading the Vercel CLI…`, async () => {
      let e = await o.runVercel([`upgrade`], {
        cwd: r,
        onOutput: (e) => {
          (s(e), e.stream === `stderr` && t.push(e.text));
        },
        signal: a,
        nonInteractive: !0,
      });
      return (e || (l = summarizeUpgradeFailure(t)), e);
    });
  } else {
    let n = await o.detectPackageManager(r);
    c = await withSpinner(
      i,
      `Installing the Vercel CLI with ${n.kind}…`,
      async () =>
        resultSucceeded(
          await o.spawnPackageManager(
            n.kind,
            r,
            globalInstallArguments(n.kind),
            { onOutput: s, signal: a, nonInteractive: !0 },
          ),
        ),
    );
  }
  if (a?.aborted === !0) return { kind: `cancelled` };
  if (!c)
    return l === void 0 ? { kind: `failed` } : { kind: `failed`, reason: l };
  let u = await withSpinner(i, `Verifying the Vercel CLI…`, probe);
  return (
    a?.throwIfAborted(),
    u
      ? { kind: `installed` }
      : n.upgrade
        ? {
            kind: `failed`,
            reason: `The Vercel CLI could not be found after the upgrade completed.`,
          }
        : { kind: `failed` }
  );
}
export { runInstallVercelCliFlow };
