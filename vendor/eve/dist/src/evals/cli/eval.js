import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { basename, join } from "node:path";
import { createDevelopmentServer } from "#internal/nitro/host.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import {
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_RUN_ID_ENV,
} from "#internal/application/dev-environment.js";
import { createEvalClient } from "#evals/cli/eval-client.js";
import { filterEvalsByTags } from "#evals/cli/filter.js";
import {
  discoverAndImportEvals,
  discoverEvalConfig,
  findMisplacedEvalDirs,
} from "#evals/runner/discover.js";
import { runEvals } from "#evals/runner/run-evals.js";
import { Console } from "#evals/runner/reporters/console.js";
import { JUnit } from "#evals/runner/reporters/junit.js";
import { resolveEvalTargetHandle } from "#evals/target.js";
async function runEvalCommand(t, r, i, s = process.cwd()) {
  loadDevelopmentEnvironmentFiles(s);
  let c = t.length > 0 ? t : void 0,
    l = await discoverAndImportEvals(s, c);
  if (l.length === 0) {
    let e = await findMisplacedEvalDirs(s);
    (e.length > 0
      ? i.error(
          `No evals found under evals/, but eval files are present inside agent/:
` +
            e.map((e) => `  - ${e}`).join(`
`) +
            `
eve eval only scans the top-level evals/ directory (a sibling of agent/). Move these files there.`,
        )
      : c
        ? i.error(`No evals found matching: ${c.join(`, `)}`)
        : i.error(
            `No evals found. Create files under evals/ with the *.eval.ts extension.`,
          ),
      (process.exitCode = 2));
    return;
  }
  let u = r.tag ?? [],
    d = r.excludeTag ?? [],
    f = filterEvalsByTags({ evaluations: l, includeTags: u, excludeTags: [] });
  if (f.length === 0) {
    (i.error(`No evals matched the provided tags (${u.join(`, `)}).`),
      (process.exitCode = 2));
    return;
  }
  let p = filterEvalsByTags({
    evaluations: f,
    includeTags: [],
    excludeTags: d,
  });
  if (r.list === !0) {
    printEvalList(p, r.json === !0, i);
    return;
  }
  if (p.length === 0) {
    i.log(
      `All ${f.length} matching evals are excluded by tags (${d.join(`, `)}); nothing to run.`,
    );
    return;
  }
  let m, h;
  try {
    ((m = parsePositiveInteger(r.maxConcurrency, `--max-concurrency`)),
      (h = parseNonNegativeInteger(r.timeout, `--timeout`)));
  } catch (e) {
    (i.error(e instanceof Error ? e.message : String(e)),
      (process.exitCode = 2));
    return;
  }
  let g;
  try {
    g = await discoverEvalConfig(s);
  } catch (e) {
    (i.error(e instanceof Error ? e.message : String(e)),
      (process.exitCode = 2));
    return;
  }
  let _, v, y;
  try {
    if (r.url)
      ((y = await createEvalClient(
        { kind: `remote`, url: r.url },
        { workspaceRoot: s },
      )),
        (v = await resolveEvalTargetHandle({
          client: y,
          expectedAgentName: await readExpectedAgentName(s),
          kind: `remote`,
          url: r.url,
        })));
    else {
      ((process.env[EVE_EVALUATION_ENV_FLAG] = `1`),
        (process.env[EVE_EVALUATION_RUN_ID_ENV] = randomUUID()),
        (_ = createDevelopmentServer(s, { host: `127.0.0.1`, port: 0 })));
      let t = await _.start();
      ((y = await createEvalClient({ kind: `local`, url: t.url })),
        (v = await resolveEvalTargetHandle({
          client: y,
          expectedAgentName: await readExpectedAgentName(s),
          kind: `local`,
          url: t.url,
        })));
    }
    let t = r.json === !0 ? [] : [Console()];
    r.junit !== void 0 && t.push(JUnit({ filePath: r.junit }));
    let n = await runEvals({
      evaluations: p,
      config: g,
      target: v,
      client: y,
      appRoot: s,
      reporters: t,
      includeEvalReporters: r.skipReport !== !0,
      maxConcurrency: m,
      timeoutMs: h,
      onEvalLog: r.verbose === !0 ? (e, t) => i.log(`[${e}] ${t}`) : void 0,
    });
    r.json && i.log(JSON.stringify(n, null, 2));
    let a = n.failed > 0,
      o = r.strict === !0 && n.scored > 0;
    (a || o) && (process.exitCode = 1);
  } finally {
    _ &&
      (await _.close(),
      await shutdownActiveSandboxHandles({ log: (e) => i.error(e) }));
  }
  let b = typeof process.exitCode == `number` ? process.exitCode : 0;
  process.exit(b);
}
function parsePositiveInteger(e, t) {
  if (e === void 0) return;
  let n = Number(e);
  if (!Number.isInteger(n) || n < 1)
    throw Error(`${t} must be a positive integer; got "${e}".`);
  return n;
}
function parseNonNegativeInteger(e, t) {
  if (e === void 0) return;
  let n = Number(e);
  if (!Number.isInteger(n) || n < 0)
    throw Error(`${t} must be a non-negative integer; got "${e}".`);
  return n;
}
function printEvalList(e, t, n) {
  if (t) {
    let t = e.map((e) => ({
      id: e.id,
      description: e.description,
      tags: e.tags,
    }));
    n.log(JSON.stringify(t, null, 2));
    return;
  }
  for (let t of e) {
    let e = t.description === void 0 ? `` : ` — ${t.description}`,
      r =
        t.tags !== void 0 && t.tags.length > 0 ? ` [${t.tags.join(`, `)}]` : ``;
    n.log(`${t.id}${r}${e}`);
  }
}
async function readExpectedAgentName(e) {
  try {
    let n = JSON.parse(await readFile(join(e, `package.json`), `utf8`));
    return typeof n.name == `string` && n.name.length > 0
      ? n.name
      : basename(e);
  } catch {
    return basename(e);
  }
}
export { runEvalCommand };
