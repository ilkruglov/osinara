import { normalizeOrigin } from "./routing.js";
import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import { readFile, writeFile } from "node:fs/promises";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { isAbsolute, join, resolve } from "node:path";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
} from "#shared/vercel-services.js";
function resolveApplicationRoot(e, t) {
  return t === void 0 || t.length === 0 ? e : isAbsolute(t) ? t : resolve(e, t);
}
function mergeProxyConfig(e, t) {
  return { ...e, [EVE_ROUTE_PREFIX]: { changeOrigin: !0, target: t } };
}
async function resolveEveDevProxyTarget(r) {
  let i = process.env[EVE_BASE_URL_ENV]?.trim();
  return i && i.length > 0
    ? normalizeOrigin(i)
    : (await resolveSharedEveDevServer(r)).origin;
}
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
async function mergeGeneratedVercelServicesConfig(e) {
  let t;
  try {
    t = await readFile(e.outputConfigPath, `utf8`);
  } catch (e) {
    if (e instanceof Error && `code` in e && e.code === `ENOENT`) return;
    throw e;
  }
  let n = JSON.parse(t);
  if (!isRecord(n))
    throw Error(`Vercel Build Output config.json must contain a JSON object.`);
  let a = mergeEveVercelConfig(n, e.generated);
  await writeFile(e.outputConfigPath, `${JSON.stringify(a, null, 2)}\n`);
}
function eveSvelteKit(e = {}) {
  let t = process.cwd(),
    n = resolveApplicationRoot(t, e.eveRoot),
    r = !1,
    i;
  return {
    enforce: `post`,
    name: `eve:sveltekit`,
    async config(r, a) {
      if (
        ((t =
          r.root === void 0 ? process.cwd() : resolve(process.cwd(), r.root)),
        (n = resolveApplicationRoot(t, e.eveRoot)),
        a.command === `build` && process.env.VERCEL)
      ) {
        let r = await ensureEveVercelServicesConfig({
          appRoot: n,
          eveBuildCommand: e.eveBuildCommand,
          frameworkName: `SvelteKit`,
          hostRoot: t,
        });
        i = r.mode === `generated` ? r : void 0;
      }
      if (a.command !== `serve`) return {};
      let o = await resolveEveDevProxyTarget(n);
      return a.isPreview
        ? { preview: { proxy: mergeProxyConfig(r.preview?.proxy, o) } }
        : { server: { proxy: mergeProxyConfig(r.server?.proxy, o) } };
    },
    configResolved(e) {
      ((r = !!e.build.ssr), (t = e.root));
    },
    closeBundle: {
      sequential: !0,
      async handler() {
        !r ||
          i === void 0 ||
          (await mergeGeneratedVercelServicesConfig({
            generated: i,
            outputConfigPath: join(t, `.vercel`, `output`, `config.json`),
          }));
      },
    },
  };
}
export { eveSvelteKit };
