import { randomBytes } from "node:crypto";
import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
} from "#protocol/routes.js";
import { isLoopbackServerUrl } from "#shared/network-address.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { eveDevArguments } from "#setup/primitives/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import {
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
  createDevelopmentSandboxRunId,
} from "#execution/sandbox/development-run.js";
import {
  pruneLocalSandboxTemplatesInBackground,
  stopDevelopmentSandboxResources,
} from "#execution/sandbox/bindings/local.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import { toErrorMessage } from "#shared/errors.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import { devBootPhase } from "#internal/dev-boot-progress.js";
import { createDevelopmentApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_HOST,
  normalizeDevelopmentServerClientUrl,
} from "#internal/nitro/host/dev-server-url.js";
import { createDevelopmentAuthoredRebuildCoordinator } from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { handleDevRuntimeArtifactsRequest } from "#internal/nitro/routes/dev-runtime-artifacts.js";
import {
  DEFAULT_DEVELOPMENT_SERVER_PORT,
  MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS,
} from "#internal/nitro/host/ports.js";
import {
  createDevelopmentWorkflowWorld,
  installWorkflowLocalQueueEnvironment,
  installWorkflowTransportEnvironment,
} from "#internal/nitro/host/dev-workflow-world-setup.js";
const MAX_ALLOWED_DEVELOPMENT_SERVER_PORT = 65535,
  PORT_ENV = `PORT`;
async function isActiveDevelopmentServerForApp(e) {
  try {
    let t = await new DevelopmentServerState(
      await resolveDiscoveryProject(e.appRoot),
    ).read();
    return t === void 0 ||
      !isLoopbackServerUrl(t) ||
      !(await isEveServerHealthy(t))
      ? !1
      : new URL(t).origin ===
          new URL(normalizeDevelopmentServerClientUrl(e.serverUrl)).origin;
  } catch {
    return !1;
  }
}
function isAddressInUseError(e) {
  return e instanceof Error && `code` in e && e.code === `EADDRINUSE`;
}
function resolveDevelopmentServerPort(e) {
  let t =
    typeof e == `string` ? Number(e) : (e ?? DEFAULT_DEVELOPMENT_SERVER_PORT);
  if (!Number.isInteger(t) || t < 0 || t > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT)
    throw Error(
      `Invalid development server port "${String(e)}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  return t;
}
function readEnvironmentPort() {
  let e = process.env[PORT_ENV];
  if (e === void 0 || e.trim() === ``) return;
  let t = Number(e);
  if (!Number.isInteger(t) || t < 0 || t > MAX_ALLOWED_DEVELOPMENT_SERVER_PORT)
    throw Error(
      `Invalid ${PORT_ENV} environment variable "${e}". Expected an integer between 0 and ${MAX_ALLOWED_DEVELOPMENT_SERVER_PORT}.`,
    );
  return t;
}
async function detectDevelopmentCommandPackageManager(e) {
  try {
    return (await detectPackageManager(e)).kind;
  } catch {
    return `pnpm`;
  }
}
async function formatDevelopmentServerConnectCommand(e, t) {
  let n = await detectDevelopmentCommandPackageManager(e);
  return [n, ...eveDevArguments(n), t].join(` `);
}
async function createDevelopmentServerAlreadyRunningError(e, t) {
  let n = await formatDevelopmentServerConnectCommand(e, t);
  return Error(
    [
      `A dev server is already running for this eve agent.`,
      `To connect to the existing instance, run: ${n}`,
    ].join(`
`),
  );
}
function resolveDevelopmentServerPorts(e) {
  let t = resolveDevelopmentServerPort(e.port);
  if (t === 0 || !e.retryOnAddressInUse) return [t];
  let n = [];
  for (let e = 0; e < MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS; e += 1) {
    let r = t + e;
    if (r > 65535) break;
    n.push(r);
  }
  return n;
}
function addDevelopmentControlHandler(e) {
  e.devServer.setControlHandler(async (a) => {
    let o = await e.workflowWorld?.handleRequest(a);
    if (o !== void 0) return o;
    let s = new URL(a.url);
    if (
      s.pathname === EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH &&
      a.method === `GET`
    )
      return handleDevRuntimeArtifactsRequest({ appRoot: e.appRoot });
    let c =
        s.pathname === EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH &&
        a.method === `POST`,
      l =
        s.pathname === EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH &&
        a.method === `POST`,
      u =
        s.pathname === EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH &&
        (a.method === `GET` || a.method === `POST`);
    if (!c && !l && !u) return;
    let d = e.getWatcher();
    return d === void 0
      ? Response.json(
          { error: `The development server is still starting.` },
          { status: 503 },
        )
      : c
        ? (await d.suspend(), Response.json({ suspended: !0 }))
        : l
          ? (await d.resume({ silent: s.searchParams.get(`silent`) === `1` }),
            handleDevRuntimeArtifactsRequest({ appRoot: e.appRoot }))
          : (s.searchParams.get(`force`) === `1`
              ? await d.rebuild()
              : await d.flush(),
            handleDevRuntimeArtifactsRequest({ appRoot: e.appRoot }));
  });
}
async function closeDevelopmentServerResources(e) {
  let t = [],
    attempt = async (e) => {
      try {
        return (await e(), !0);
      } catch (e) {
        return (t.push(e), !1);
      }
    },
    n = e.authoredSourceWatcher;
  n !== void 0 && (await attempt(() => n.close()));
  let r = e.workflowWorld;
  r !== void 0 && (await attempt(() => r.close()));
  let i = e.devServer,
    a = i === void 0 || (await attempt(() => i.close())),
    o = e.nitro;
  return (
    o !== void 0 && (await attempt(() => o.close())),
    await attempt(() =>
      stopDevelopmentSandboxResources({
        appRoot: e.appRoot,
        devRunId: e.developmentSandboxRunId,
        log: (e) => console.warn(`[eve:dev] ${e}`),
      }),
    ),
    { errors: t, listenerClosed: a }
  );
}
function createDevelopmentServerCleanupError(e) {
  if (e.length !== 0) {
    if (e.length === 1) {
      let t = e[0];
      return t instanceof Error
        ? t
        : Error(
            `Failed to close the development server: ${toErrorMessage(t)}`,
            { cause: t },
          );
    }
    return AggregateError(
      e,
      `Multiple development-server resources failed to close.`,
    );
  }
}
function createDevelopmentServerStartupCleanupError(e, t) {
  return AggregateError(
    [e, ...t],
    `${toErrorMessage(e)} Cleanup also failed.`,
    { cause: e },
  );
}
async function listenForDevelopmentServer(e) {
  let t = resolveDevelopmentServerPorts({
      port: e.port,
      retryOnAddressInUse: e.retryOnAddressInUse,
    }),
    n;
  for (let r of t) {
    let t = e.devServer.listen({ hostname: e.host, port: r });
    try {
      return (await t.ready(), t);
    } catch (r) {
      if (
        ((n = r),
        await t.close().catch(() => {}),
        !isAddressInUseError(r) || !e.retryOnAddressInUse)
      )
        throw r;
    }
  }
  throw Error(
    `Failed to start Nitro dev server after ${t.length} attempts. Tried ports ${t.join(`, `)}.`,
    { cause: n },
  );
}
async function startNitroDevelopmentServer(t, n) {
  process.env[EVE_DEV_ENV_FLAG] ??= `1`;
  let r = await resolveDiscoveryProject(t);
  loadDevelopmentEnvironmentFiles(r.appRoot);
  let i = readEnvironmentPort(),
    c = n.port ?? i,
    l = n.host !== void 0 || n.port !== void 0 || i !== void 0,
    f = new DevelopmentServerState(r),
    m = await f.read();
  if (m !== void 0 && isLoopbackServerUrl(m) && (await isEveServerHealthy(m))) {
    if (n.existing === `attach-if-unconfigured` && !l)
      return {
        handle: { kind: `existing`, appRoot: r.appRoot, url: m },
        close: void 0,
      };
    throw await createDevelopmentServerAlreadyRunningError(r.appRoot, m);
  }
  let v = process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV],
    y = createDevelopmentSandboxRunId();
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = y;
  let b,
    x,
    S,
    C,
    w,
    T,
    E,
    D = !1,
    O = !1;
  try {
    let t = await devBootPhase(
      `compiling agent`,
      () => prepareDevelopmentApplicationHost(r.appRoot),
      n.onBootProgress,
    );
    E = t;
    let i = resolveNitroCompiledArtifactsSource(
      createDevelopmentNitroArtifactsConfig({
        appRoot: t.appRoot,
        configuredWorld:
          t.compileResult.manifest.config.experimental?.workflow?.world,
      }),
    );
    pruneLocalSandboxTemplatesInBackground(t.appRoot);
    let a = await devBootPhase(
      `creating dev server`,
      () => createDevelopmentApplicationNitro(t),
      n.onBootProgress,
    );
    ((b = a), (x = new DrainedNitroDevServer(a.logger)));
    let o = x,
      s = randomBytes(32).toString(`base64url`);
    (o.setClientAddressSecret(s),
      (C = installWorkflowTransportEnvironment(r.appRoot, s)),
      (w = createDevelopmentWorkflowWorld({
        appRoot: r.appRoot,
        preparedHost: t,
        transportSecret: s,
      })),
      addDevelopmentControlHandler({
        appRoot: r.appRoot,
        devServer: o,
        getWatcher: () => T,
        workflowWorld: w,
      }));
    let l =
        n.host ??
        a.options.devServer.hostname ??
        DEFAULT_DEVELOPMENT_SERVER_HOST,
      u = c === void 0,
      d = await devBootPhase(
        `binding port`,
        () =>
          listenForDevelopmentServer({
            devServer: o,
            host: l,
            port: c,
            retryOnAddressInUse: u,
          }),
        n.onBootProgress,
      );
    if (!d.url) throw Error(`Nitro dev server did not expose a URL.`);
    let p = normalizeDevelopmentServerClientUrl(d.url);
    ((S = installWorkflowLocalQueueEnvironment(p)),
      await devBootPhase(
        `building dev bundle`,
        async () => {
          let e = await buildDevelopmentHostCandidate({ host: t, nitro: a });
          b = void 0;
          let n = t.workspace;
          ((O = !0),
            await o.replaceWorker({
              dispose: async () => await removeDevelopmentHostWorkspace(n),
              entry: e.entry,
              workerData: e.workerData,
            }),
            await activateDevelopmentGeneration({
              appRoot: t.appRoot,
              generation: t.generation,
            }),
            (D = !0));
        },
        n.onBootProgress,
      ),
      await w?.start(),
      startDevelopmentSandboxPrewarmInBackground({
        appRoot: t.appRoot,
        compiledArtifactsSource: i,
      }));
    let m = await createDevelopmentAuthoredRebuildCoordinator({
      devServer: o,
      initialHost: t,
    });
    ((T = await devBootPhase(
      `starting file watcher`,
      async () => {
        let { startAuthoredSourceWatcher: e } = await import(
          `#internal/nitro/host/dev-authored-source-watcher.js`
        );
        return e({ coordinator: m, preparedHost: t });
      },
      n.onBootProgress,
    )),
      await f.write(p));
    let h = S;
    if (h === void 0)
      throw Error(`Workflow local queue environment was not initialized.`);
    let g = T,
      _ = x,
      k = w,
      A = C,
      j;
    return {
      handle: { kind: `started`, appRoot: r.appRoot, url: p },
      close: () => (
        (j ??= (async () => {
          let e = await closeDevelopmentServerResources({
            appRoot: r.appRoot,
            authoredSourceWatcher: g,
            devServer: _,
            developmentSandboxRunId: y,
            nitro: void 0,
            workflowWorld: k,
          });
          e.listenerClosed && (await f.remove().catch(() => {}));
          try {
            let t = createDevelopmentServerCleanupError(e.errors);
            if (t !== void 0) throw t;
          } finally {
            (h(), A?.(), restoreDevelopmentSandboxRunId(v));
          }
        })()),
        j
      ),
    };
  } catch (e) {
    let t = await closeDevelopmentServerResources({
        appRoot: r.appRoot,
        authoredSourceWatcher: T,
        devServer: x,
        developmentSandboxRunId: y,
        nitro: b,
        workflowWorld: w,
      }),
      n = [...t.errors];
    throw (
      E !== void 0 &&
        !D &&
        (await discardDevelopmentGeneration(E.generation).catch((e) => {
          n.push(e);
        })),
      E !== void 0 &&
        !O &&
        (await removeDevelopmentHostWorkspace(E.workspace).catch((e) => {
          n.push(e);
        })),
      S?.(),
      C?.(),
      t.listenerClosed && (await f.remove().catch(() => {})),
      restoreDevelopmentSandboxRunId(v),
      n.length > 0 ? createDevelopmentServerStartupCleanupError(e, n) : e
    );
  }
}
function createDevelopmentServer(e, t = {}) {
  let n, r;
  return {
    start() {
      if (n !== void 0)
        throw Error(`DevelopmentServer.start() was already called.`);
      return (
        (n = startNitroDevelopmentServer(e, t).then(
          ({ handle: e, close: t }) => ((r = t), e),
        )),
        n
      );
    },
    async close() {
      n !== void 0 && (await n.catch(() => void 0), await r?.());
    },
  };
}
function restoreDevelopmentSandboxRunId(e) {
  if (e === void 0) {
    delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    return;
  }
  process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = e;
}
export {
  createDevelopmentServer,
  isActiveDevelopmentServerForApp,
  normalizeDevelopmentServerClientUrl,
};
