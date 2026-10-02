import { mkdir, readFile } from "node:fs/promises";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { dirname, join, relative } from "node:path";
import {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/paths.js";
import { findClosestLinkedVercelDirectory } from "#shared/vercel-output-directory.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
const VERCEL_JSON_FILE_NAME = `vercel.json`,
  EVE_SERVICE_ROUTE_SRC = `^${EVE_ROUTE_PREFIX}/(.*)$`,
  EVE_SERVICE_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/$1`;
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
function toPosixRelative(e, t) {
  let n = relative(e, t);
  return n.length === 0 ? `.` : n.replaceAll(`\\`, `/`);
}
function quoteShellArgument(e) {
  return `'${e.replaceAll(`'`, `'\\''`)}'`;
}
function isNamedServiceConfigArray(e) {
  return Array.isArray(e);
}
function createServiceConfigRecord(e) {
  if (e === void 0) return {};
  if (isNamedServiceConfigArray(e)) {
    let t = {};
    for (let n of e)
      if (typeof n.name == `string` && n.name.trim().length > 0) {
        let { name: e, ...r } = n;
        t[e] = r;
      }
    return t;
  }
  return e;
}
function normalizeVercelJsonConfig(e) {
  if (!isRecord(e))
    throw Error(`${VERCEL_JSON_FILE_NAME} must contain a JSON object.`);
  let t = e.services;
  if (
    t !== void 0 &&
    !isRecord(t) &&
    !(
      Array.isArray(t) &&
      t.every(
        (e) =>
          isRecord(e) && typeof e.name == `string` && e.name.trim().length > 0,
      )
    )
  )
    throw Error(
      `${VERCEL_JSON_FILE_NAME} services must be a JSON object or named service array.`,
    );
  return e;
}
async function readVercelJsonConfig(e) {
  try {
    return normalizeVercelJsonConfig(JSON.parse(await readFile(e, `utf8`)));
  } catch (e) {
    if (e instanceof Error && `code` in e && e.code === `ENOENT`) return {};
    throw e;
  }
}
function findEveService(e) {
  return Object.values(e).find((e) => e.framework === `eve`);
}
function assertRootServicesIncludeEve(e, t) {
  if (findEveService(e) === void 0)
    throw Error(
      `${VERCEL_JSON_FILE_NAME} already defines services, so the eve ${t} integration cannot add a generated eve service. Add an eve service (framework "eve") and a rewrite from ${EVE_ROUTE_PREFIX}/(.*) to it in ${VERCEL_JSON_FILE_NAME}, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
    );
}
function createEveServiceRoute(e = `eve`) {
  return {
    destination: { service: e, type: `service` },
    src: EVE_SERVICE_ROUTE_SRC,
  };
}
function createEveServiceRequestPathRoute() {
  return {
    src: EVE_SERVICE_ROUTE_SRC,
    transforms: [
      { args: EVE_SERVICE_ROUTE_PATH, op: `set`, type: `request.path` },
    ],
  };
}
function isEveServiceRoute(e, t) {
  let n = e.destination;
  return (
    e.src === EVE_SERVICE_ROUTE_SRC &&
    isRecord(n) &&
    n.type === `service` &&
    n.service === t
  );
}
function insertEveServiceRoute(e, t) {
  let n = e.filter((e) => !(isRecord(e) && isEveServiceRoute(e, t))),
    r = n.findIndex((e) => isRecord(e) && e.handle === `filesystem`);
  return r === -1
    ? [createEveServiceRoute(t), ...n]
    : [...n.slice(0, r), createEveServiceRoute(t), ...n.slice(r)];
}
function insertEveServiceRequestPathRoute(e) {
  let t = (e ?? []).filter((e) => e.src !== EVE_SERVICE_ROUTE_SRC);
  return [createEveServiceRequestPathRoute(), ...t];
}
function createGeneratedServiceBuild(e) {
  let t = join(e.hostRoot, `.eve/vercel-services`, `eve`),
    n = join(t, `.vercel`, `output`),
    r = join(e.hostRoot, `.vercel`, `output`),
    a = toPosixRelative(t, e.appRoot),
    c = toPosixRelative(e.appRoot, n),
    u = toPosixRelative(e.appRoot, r),
    d =
      e.eveBuildCommand ??
      `node ${quoteShellArgument(toPosixRelative(e.appRoot, resolveEveBinaryPath(e.hostRoot)))} build`;
  return {
    buildCommand: `cd ${quoteShellArgument(a)} && export ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(c)} && export ${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(u)} && ${d}`,
    root: toPosixRelative(e.hostRoot, t),
    rootDirectory: t,
  };
}
async function ensureEveVercelServicesConfig(t) {
  let n = await findClosestLinkedVercelDirectory(t.hostRoot),
    a = n === void 0 ? t.hostRoot : dirname(n),
    o = await readVercelJsonConfig(join(t.hostRoot, VERCEL_JSON_FILE_NAME)),
    s =
      a === t.hostRoot ||
      Object.keys(createServiceConfigRecord(o.services)).length > 0
        ? o
        : await readVercelJsonConfig(join(a, VERCEL_JSON_FILE_NAME)),
    l = createServiceConfigRecord(s.services);
  if (Object.keys(l).length > 0)
    return (assertRootServicesIncludeEve(l, t.frameworkName), { mode: `root` });
  s.experimentalServices !== void 0 &&
    console.warn(
      `[eve] ${VERCEL_JSON_FILE_NAME} defines experimentalServices, which Vercel no longer routes. The eve ${t.frameworkName} integration now generates the stable services config automatically — remove experimentalServices from ${VERCEL_JSON_FILE_NAME}.`,
    );
  let d = createGeneratedServiceBuild(t);
  return (
    await mkdir(d.rootDirectory, { recursive: !0 }),
    {
      mode: `generated`,
      services: {
        eve: {
          buildCommand: d.buildCommand,
          framework: `eve`,
          routes: [createEveServiceRequestPathRoute()],
          root: d.root,
        },
      },
    }
  );
}
function mergeEveVercelConfig(e, t) {
  let n = e?.services ?? {},
    r = Object.entries(n).find(
      ([e, t]) => e === `eve` || t.framework === `eve`,
    ),
    i = r?.[0] ?? `eve`,
    a = r
      ? {
          ...n,
          [i]: {
            ...r[1],
            routes: insertEveServiceRequestPathRoute(r[1].routes),
          },
        }
      : { ...n, ...t.services };
  return {
    version: 3,
    ...e,
    routes: insertEveServiceRoute(e?.routes ?? [], i),
    services: a,
  };
}
export {
  createEveServiceRequestPathRoute,
  createEveServiceRoute,
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
};
