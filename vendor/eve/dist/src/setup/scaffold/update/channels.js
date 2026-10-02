import { appendEnv } from "../../append-env.js";
import { pinnedNodeEngineMajor } from "../../node-engine.js";
import {
  getSupportedModuleBaseName,
  matchesSupportedModuleBaseName,
} from "./module-files.js";
import { pathExists, writeTextFile } from "../files.js";
import { resolveVersionToken } from "../version-tokens.js";
import { patchPackageJson } from "./package-json.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
} from "../workspace-root.js";
import {
  WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_PACKAGE_JSON,
} from "../create/web-template.js";
import { resolveEvePackageContract } from "../create/project.js";
import { resolveWebPackageVersions } from "./web-options.js";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
const SLACK_CHANNEL_DEFAULT_ROUTE = `/eve/v1/slack`,
  DEFAULT_SLACK_CONNECTOR_SLUG = `my-agent`,
  NEXT_PACKAGE_NAME = `next`,
  PACKAGE_DEPENDENCY_FIELDS = [`dependencies`, `devDependencies`],
  WEB_NEXT_CONFIG_PATH = `next.config.ts`,
  WEB_COMPETING_NEXT_CONFIG_PATHS = [
    `next.config.js`,
    `next.config.mjs`,
    WEB_NEXT_CONFIG_PATH,
    `next.config.mts`,
  ].filter((e) => e !== WEB_NEXT_CONFIG_PATH);
function toSlackConnectorSlug(e) {
  return e;
}
function isJsonObject(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
async function readPackageJsonObject(e) {
  if (!(await pathExists(e))) return;
  let t = JSON.parse(await readFile(e, `utf8`));
  return isJsonObject(t) ? t : void 0;
}
async function readDependencyVersion(e, t) {
  let n = await readPackageJsonObject(e);
  if (n === void 0 || !isJsonObject(n.dependencies)) return;
  let r = n.dependencies[t];
  return typeof r == `string` ? r : void 0;
}
function packageJsonHasDependency(e, t) {
  for (let n of PACKAGE_DEPENDENCY_FIELDS) {
    let r = e[n];
    if (isJsonObject(r) && typeof r[t] == `string`) return !0;
  }
  return !1;
}
async function hasPackageDependency(e, t) {
  let n = await readPackageJsonObject(e);
  return n !== void 0 && packageJsonHasDependency(n, t);
}
async function isNextJsProject(e) {
  return hasPackageDependency(join(e, `package.json`), NEXT_PACKAGE_NAME);
}
const VERCEL_HOST_FRAMEWORK_PRESETS = {
  "@sveltejs/kit": `sveltekit`,
  [NEXT_PACKAGE_NAME]: `nextjs`,
  nuxt: `nuxtjs`,
  nuxt3: `nuxtjs`,
  "nuxt-edge": `nuxtjs`,
  "nuxt-nightly": `nuxtjs`,
};
async function resolveVercelHostFrameworkPreset(e) {
  let t = await readPackageJsonObject(join(e, `package.json`));
  if (t !== void 0) {
    for (let [e, n] of Object.entries(VERCEL_HOST_FRAMEWORK_PRESETS))
      if (packageJsonHasDependency(t, e)) return n;
  }
}
async function hasVercelHostFramework(e) {
  return (await resolveVercelHostFrameworkPreset(e)) !== void 0;
}
async function ensurePackageDependency(e, t, n) {
  return !(await pathExists(e)) || (await readDependencyVersion(e, t)) === n
    ? []
    : (await patchPackageJson(e, { dependencies: { [t]: n } }),
      [{ path: e, dependencies: [t], devDependencies: [], scripts: [] }]);
}
function formatEveDependencySpecifier(e) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/.test(e) ? `^${e}` : e;
}
async function patchWebPackageJson(e, n, r, a, c, d = !0, f) {
  let h = join(e, `package.json`);
  if (!(await pathExists(h))) return { mutations: [] };
  let g = resolveEvePackageContract(a.evePackage),
    _ = pinnedNodeEngineMajor(g.nodeEngine),
    v = {
      ...WEB_APP_TEMPLATE_PACKAGE_JSON.dependencies,
      ai: resolveVersionToken(`aiPackageVersion`, a.aiPackageVersion),
      eve: formatEveDependencySpecifier(g.version),
      next: resolveVersionToken(`nextPackageVersion`, a.nextPackageVersion),
      react: resolveVersionToken(`reactPackageVersion`, a.reactPackageVersion),
      "react-dom": resolveVersionToken(
        `reactDomPackageVersion`,
        a.reactDomPackageVersion,
      ),
      streamdown: resolveVersionToken(
        `streamdownPackageVersion`,
        a.streamdownPackageVersion,
      ),
      zod: resolveVersionToken(`zodPackageVersion`, a.zodPackageVersion),
      ...(f === `sign-in-with-vercel`
        ? {
            "better-auth": resolveVersionToken(
              `betterAuthPackageVersion`,
              a.betterAuthPackageVersion,
            ),
          }
        : {}),
    },
    y = {
      ...WEB_APP_TEMPLATE_PACKAGE_JSON.devDependencies,
      "@types/node": _,
      "@types/react": resolveVersionToken(
        `typesReactPackageVersion`,
        a.typesReactPackageVersion,
      ),
      "@types/react-dom": resolveVersionToken(
        `typesReactDomPackageVersion`,
        a.typesReactDomPackageVersion,
      ),
      typescript: `6.0.3`,
    },
    b = WEB_APP_TEMPLATE_PACKAGE_JSON.scripts,
    x = isPackageManagerWorkspaceMember(n, r),
    S = { scripts: b };
  (d && ((S.dependencies = v), (S.devDependencies = y)),
    x || (S.nodeEngineRequirement = g.nodeEngine));
  let C = await patchPackageJson(h, S),
    w =
      (
        await patchWorkspaceRootPackageJson(n, r, {
          aiPackageVersion: v.ai,
          nodeEngineRequirement: g.nodeEngine,
          onWorkspaceRootMutation: c,
        })
      ).nodeEngineOverride ?? C.nodeEngineOverride;
  return {
    mutations: [
      {
        path: h,
        dependencies: d ? Object.keys(v) : [],
        devDependencies: d ? Object.keys(y) : [],
        scripts: Object.keys(b),
      },
    ],
    nodeEngineOverride: w,
  };
}
function normalizeSlackConnectorSlug(e) {
  return toSlackConnectorSlug(
    (e.trim().replace(/^@/, ``).split(`/`).at(-1) ?? ``)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, `-`)
      .replace(/^[^a-z0-9]+/, ``)
      .replace(/[^a-z0-9]+$/, ``)
      .slice(0, 100)
      .replace(/[^a-z0-9]+$/, ``) || `my-agent`,
  );
}
async function deriveSlackConnectorSlug(e, t) {
  if (t !== void 0 && t.length > 0 && t !== `.`)
    return normalizeSlackConnectorSlug(t);
  try {
    let t = await readFile(join(e, `package.json`), `utf8`),
      n = JSON.parse(t);
    if (typeof n.name == `string` && n.name.length > 0)
      return normalizeSlackConnectorSlug(n.name);
  } catch {}
  return normalizeSlackConnectorSlug(basename(resolve(e)) || `my-agent`);
}
function buildSlackConnectTemplate(e) {
  if (!e.startsWith(`slack/`) || e.length === 6)
    throw Error(`Invalid Slack connector UID "${e}".`);
  return `import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials(${JSON.stringify(e)}),
});
`;
}
const SLACK_ENV_EXAMPLE_VALUES = {
  SLACK_BOT_TOKEN: ``,
  SLACK_SIGNING_SECRET: ``,
};
function renderWebAppTemplate(e, t) {
  return e
    .replaceAll(`__EVE_INIT_APP_NAME__`, t)
    .replaceAll(`__EVE_INIT_WITH_EVE_OPTIONS__`, ``);
}
async function ensureWebVercelJson(e) {
  return (await pathExists(e))
    ? `skipped`
    : (await writeTextFile(
        e,
        `${JSON.stringify({ $schema: `https://openapi.vercel.sh/vercel.json` }, null, 2)}\n`,
        { force: !0 },
      ),
      `written`);
}
async function findCompetingNextConfigFiles(e) {
  let t = [];
  for (let n of WEB_COMPETING_NEXT_CONFIG_PATHS) {
    let r = join(e, n);
    (await pathExists(r)) && t.push(r);
  }
  return t;
}
async function ensureChannel(e) {
  switch (e.kind) {
    case `slack`:
      return ensureSlackChannel({ ...e, kind: `slack` });
    case `web`:
      return ensureWebChannel({ ...e, kind: `web` });
  }
}
async function ensureWebChannel(e) {
  let t = join(e.projectRoot, `package.json`),
    n = await pathExists(join(e.projectRoot, `app/page.tsx`));
  if (!e.force && (await isNextJsProject(e.projectRoot)))
    return {
      kind: `web`,
      action: `skipped`,
      skipReason: `nextjs-project`,
      filesWritten: [],
      filesSkipped: [t],
      packageJsonUpdated: [],
    };
  let r = resolveWebPackageVersions(e.webPackageVersions, e.webAuthentication),
    o = e.packageManager ?? `pnpm`,
    s = resolve(e.workspaceProbeDirectory ?? e.projectRoot),
    l = await patchWebPackageJson(
      e.projectRoot,
      o,
      s,
      r,
      e.onWorkspaceRootMutation,
      !e.skipDependencyMutation,
      e.webAuthentication,
    ),
    u = [],
    p = [],
    m = [],
    g = [],
    _ = basename(resolve(e.projectRoot));
  if (e.configureVercelServices ?? !0) {
    let t = join(e.projectRoot, `vercel.json`);
    (await ensureWebVercelJson(t)) === `written` ? u.push(t) : g.push(t);
  }
  let v = await applyPackageManagerWorkspaceConfiguration({
    packageManager: o,
    projectRoot: e.projectRoot,
    workspaceProbeRoot: s,
    onWorkspaceRootMutation: e.onWorkspaceRootMutation,
  });
  if (
    (u.push(...v.filesWritten),
    g.push(...v.filesSkipped),
    !e.skipDependencyMutation)
  ) {
    let t = {
      ...WEB_APP_TEMPLATE_FILES,
      ...(e.webAuthentication === `sign-in-with-vercel`
        ? WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES
        : {}),
    };
    for (let [n, r] of Object.entries(t)) {
      let t = join(e.projectRoot, n);
      if (n === `agent/channels/eve.ts` && !e.force && (await pathExists(t))) {
        g.push(t);
        continue;
      }
      let o = await pathExists(t);
      (await writeTextFile(t, renderWebAppTemplate(r, _), { force: !0 }),
        u.push(t),
        o && p.push(t));
    }
  }
  m.push(...(await findCompetingNextConfigFiles(e.projectRoot)));
  let y = [...new Set(u)],
    S = [...new Set(g)].filter((e) => !y.includes(e)),
    C = {
      kind: `web`,
      action: n ? `overwritten` : `created`,
      filesWritten: y,
      filesSkipped: S,
      packageJsonUpdated: l.mutations,
    };
  return (
    p.length > 0 && (C.filesOverwritten = p),
    m.length > 0 && (C.competingNextConfigFiles = m),
    l.nodeEngineOverride !== void 0 &&
      (C.nodeEngineOverride = l.nodeEngineOverride),
    C
  );
}
async function ensureSlackChannel(t) {
  let n = join(t.projectRoot, `agent/channels/slack.ts`),
    r = await pathExists(n);
  if (!t.force && r)
    return {
      kind: `slack`,
      action: `skipped`,
      filesWritten: [],
      filesSkipped: [n],
      packageJsonUpdated: [],
    };
  let s = t.slackCredentials ?? `vercel-connect`,
    c = t.slackConnectorSlug ?? (await deriveSlackConnectorSlug(t.projectRoot)),
    l,
    u = [],
    d = [n],
    f = [],
    p;
  if (s === `vercel-connect`) {
    if (!t.skipDependencyMutation) {
      let e = resolveVersionToken(
        `connectPackageVersion`,
        t.connectPackageVersion ?? `0.4.3`,
      );
      u = await ensurePackageDependency(
        join(t.projectRoot, `package.json`),
        `@vercel/connect`,
        e,
      );
    }
    l = buildSlackConnectTemplate(t.slackConnectorUid ?? `slack/${c}`);
  } else {
    l = `import { slackChannel } from "eve/channels/slack";

export default slackChannel();
`;
    let n = join(t.projectRoot, `.env.example`);
    ((p = {
      path: n,
      ...((await pathExists(n)) ? { content: await readFile(n, `utf8`) } : {}),
    }),
      (await appendEnv(n, SLACK_ENV_EXAMPLE_VALUES)).written.length > 0
        ? d.push(n)
        : f.push(n));
  }
  try {
    await writeTextFile(n, l, { force: t.force });
  } catch (e) {
    throw (
      p !== void 0 &&
        (p.content === void 0
          ? await unlink(p.path)
          : await writeFile(p.path, p.content, `utf8`)),
      e
    );
  }
  let m = {
    kind: `slack`,
    action: r ? `overwritten` : `created`,
    filesWritten: d,
    filesSkipped: f,
    packageJsonUpdated: u,
    slackConnectorSlug: c,
  };
  return (r && (m.filesOverwritten = [n]), m);
}
async function listAuthoredChannels(e) {
  let t = join(e, `channels`),
    i;
  try {
    i = await readdir(t, { withFileTypes: !0 });
  } catch (e) {
    if (e.code === `ENOENT`) return [];
    throw e;
  }
  let a = [];
  for (let e of i) {
    if (e.isFile()) {
      let t = getSupportedModuleBaseName(e.name);
      t !== null && a.push(t);
      continue;
    }
    if (e.isDirectory())
      try {
        (await readdir(join(t, e.name))).some((e) =>
          matchesSupportedModuleBaseName(e, `connection`),
        ) && a.push(e.name);
      } catch {}
  }
  return a.sort();
}
export {
  DEFAULT_SLACK_CONNECTOR_SLUG,
  SLACK_CHANNEL_DEFAULT_ROUTE,
  deriveSlackConnectorSlug,
  ensureChannel,
  hasVercelHostFramework,
  isNextJsProject,
  listAuthoredChannels,
  normalizeSlackConnectorSlug,
  resolveVercelHostFrameworkPreset,
};
