import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import {
  createFileBackedInternalSandboxSession,
  pathExists,
} from "#execution/sandbox/bindings/local-backend-utils.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
let justBashModulePromise;
async function loadJustBashModule(e) {
  return (
    (justBashModulePromise ??= loadOptionalEnginePackage({
      appRoot: e.appRoot,
      autoInstall: e.autoInstall,
      importModule: async () => await import(`just-bash`),
      missingMessage:
        "The just-bash sandbox backend requires the `just-bash` package, which is not bundled with eve. Install it in your application (for example `pnpm add -D just-bash`), or use docker() / defaultSandbox() instead.",
      packageName: `just-bash`,
    }).catch((e) => {
      throw ((justBashModulePromise = void 0), e);
    })),
    await justBashModulePromise
  );
}
async function createBashSandbox(t) {
  let n = await loadJustBashModule({
      appRoot: t.appRoot,
      autoInstall: t.autoInstall,
    }),
    { ReadWriteFs: r, Sandbox: i } = n,
    a = resolveLocalSandboxFilesystemRootPath(t.rootPath),
    o = resolveLocalSandboxMetadataPath(t.rootPath),
    s = await readLocalMetadata(o);
  await mkdir(a, { recursive: !0 });
  let c = new r({ allowSymlinks: !0, maxFileReadSize: 2 ** 53 - 1, root: a }),
    l = c;
  if (t.filesystem !== void 0)
    try {
      l = await t.filesystem({
        appRoot: t.appRoot,
        defaultFilesystem: c,
        justBash: n,
      });
    } catch (e) {
      throw Error(`Failed to create the custom just-bash filesystem.`, {
        cause: e,
      });
    }
  await ensureLocalSandboxDirectories(l);
  let u = await i.create({
    cwd: WORKSPACE_ROOT,
    env: s?.env,
    fs: l,
    network: { dangerouslyAllowFullInternetAccess: !0 },
  });
  return {
    async captureState() {
      return (
        await writeLocalMetadata(o, {
          env: { ...u.bashEnvInstance.getEnv() },
          version: 1,
        }),
        { rootPath: t.rootPath }
      );
    },
    async dispose() {
      await u.stop();
    },
    async readFileBytes(e) {
      let t;
      try {
        t = await l.readFileBuffer(e);
      } catch {
        return null;
      }
      return Buffer.from(t);
    },
    async removePath(e) {
      await l.rm(e.path, { force: e.force, recursive: e.recursive });
    },
    rootPath: t.rootPath,
    sessionKey: t.sessionKey,
    async spawn(e) {
      if (e.abortSignal?.aborted)
        throw new DOMException(`The operation was aborted.`, `AbortError`);
      let t =
        e.workingDirectory === void 0
          ? e.command
          : `( cd ${shellQuote(e.workingDirectory)} && ${e.command} )`;
      return adaptMultiplexedCommandToSandboxProcess({
        command: await u.runCommand({
          args: [t],
          cmd: `eval`,
          detached: !0,
          env: e.env,
          signal: e.abortSignal,
        }),
        getOutput: (e) => e.type,
      });
    },
    async writeFiles(e) {
      for (let t of e) {
        let e = dirname(t.path);
        (await l.mkdir(e, { recursive: !0 }),
          await l.writeFile(t.path, t.content));
      }
    },
  };
}
async function justBashSetNetworkPolicyUnsupported() {
  throw Error(
    `setNetworkPolicy() is not supported on the just-bash sandbox backend. just-bash applies its network policy only at sandbox creation (no run-time update) and does not run git or other binaries. Use docker() for coarse egress control or vercel() / microsandbox() for credential brokering.`,
  );
}
function createJustBashHandle(e, t) {
  let n = buildSandboxSession(
    createFileBackedInternalSandboxSession({ id: e.sessionKey, sandbox: e }),
    justBashSetNetworkPolicyUnsupported,
  );
  return {
    session: n,
    useSessionFn: async () => n,
    async captureState() {
      return {
        backendName: t,
        metadata: (await e.captureState()) ?? {},
        sessionKey: e.sessionKey,
      };
    },
    async stop() {
      await e.dispose();
    },
    async shutdown() {
      await e.dispose();
    },
  };
}
function resolveLocalSandboxFilesystemRootPath(e) {
  return `${e}/fs`;
}
function resolveLocalSandboxMetadataPath(e) {
  return `${e}/metadata.json`;
}
async function ensureLocalSandboxDirectories(e) {
  await e.mkdir(WORKSPACE_ROOT, { recursive: !0 });
}
async function readLocalMetadata(e) {
  if (!(await pathExists(e))) return null;
  let n = JSON.parse(await readFile(e, `utf8`));
  return n.version !== 1 || !isStringRecord(n.env)
    ? null
    : { env: n.env, version: 1 };
}
async function writeLocalMetadata(t, r) {
  (await mkdir(dirname(t), { recursive: !0 }),
    await writeFile(t, `${JSON.stringify(r, null, 2)}\n`));
}
function isStringRecord(e) {
  return (
    typeof e == `object` &&
    !!e &&
    !Array.isArray(e) &&
    Object.values(e).every((e) => typeof e == `string`)
  );
}
export {
  createBashSandbox,
  createJustBashHandle,
  justBashSetNetworkPolicyUnsupported,
};
