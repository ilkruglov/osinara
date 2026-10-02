import {
  resolvePackageDependencyPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { computeApplicationChannelRouteRegistrations } from "#internal/nitro/host/application-route-registry.js";
const EVE_CHANNEL_VIRTUAL_ID_PREFIX = `#nitro/virtual/eve-channel/`;
function computeChannelRouteRegistrations(e) {
  return computeApplicationChannelRouteRegistrations(e);
}
function registerChannelVirtualHandlers(e, t) {
  for (let n of t.routes)
    addChannelVirtualHandler(e, {
      artifactsConfig: t.artifactsConfig,
      route: n,
    });
}
function createChannelRouteKey(e) {
  return `${e.method.toUpperCase()} ${e.path}`;
}
function addChannelVirtualHandler(r, i) {
  if (i.route.kind === `channel-preflight`) {
    addChannelCorsPreflightHandler(r, i.route);
    return;
  }
  let a = createChannelRouteKey(i.route),
    o = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${a}`,
    s = stringifyEsmImportSpecifier(
      resolvePackageSourceFilePath(
        `src/internal/nitro/routes/channel-dispatch.ts`,
      ),
    ),
    c = stringifyEsmImportSpecifier(resolvePackageDependencyPath(`nitro`)),
    l = stringifyEsmImportSpecifier(resolvePackageDependencyPath(`nitro/h3`));
  if (i.route.method === `WEBSOCKET`) {
    (r.options.handlers.push({ handler: o, route: i.route.path }),
      (r.options.virtual[o] = [
        `import { defineWebSocketHandler } from ${c};`,
        `import { dispatchChannelWebSocketRequest } from ${s};`,
        `const config = ${JSON.stringify(i.artifactsConfig)};`,
        `export default defineWebSocketHandler((event) => dispatchChannelWebSocketRequest(event, ${JSON.stringify(a)}, config));`,
      ].join(`
`)));
    return;
  }
  (r.options.handlers.push({
    handler: o,
    method: i.route.method,
    route: i.route.path,
  }),
    (r.options.virtual[o] = [
      ...(i.route.cors === void 0
        ? []
        : [
            `import { handleCors } from ${l};`,
            `const cors = ${JSON.stringify(i.route.cors)};`,
          ]),
      `import { dispatchChannelRequest } from ${s};`,
      `const config = ${JSON.stringify(i.artifactsConfig)};`,
      i.route.cors === void 0
        ? `export default (event) => dispatchChannelRequest(event, ${JSON.stringify(a)}, config);`
        : [
            `export default (event) => {`,
            `  const corsResponse = handleCors(event, cors);`,
            `  if (corsResponse !== false) return corsResponse;`,
            `  return dispatchChannelRequest(event, ${JSON.stringify(a)}, config);`,
            `};`,
          ].join(`
`),
    ].join(`
`)));
}
function addChannelCorsPreflightHandler(t, r) {
  let i = createChannelRouteKey(r),
    a = `${EVE_CHANNEL_VIRTUAL_ID_PREFIX}${i}`,
    o = stringifyEsmImportSpecifier(resolvePackageDependencyPath(`nitro/h3`));
  (t.options.handlers.push({ handler: a, method: `OPTIONS`, route: r.path }),
    (t.options.virtual[a] = [
      `import { handleCors } from ${o};`,
      `const cors = ${JSON.stringify(r.cors)};`,
      `export default (event) => {`,
      `  const corsResponse = handleCors(event, cors);`,
      `  if (corsResponse !== false) return corsResponse;`,
      `  return new Response(null, { status: 204 });`,
      `};`,
    ].join(`
`)));
}
export { computeChannelRouteRegistrations, registerChannelVirtualHandlers };
