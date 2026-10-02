import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { existsSync } from "node:fs";
import {
  COMPILED_AGENT_MANIFEST_KIND,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import {
  bundleAuthoredModuleForGeneration,
  bundleAuthoredModuleMapForGeneration,
} from "#internal/authored-module-loader.js";
import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";
import { serializeCompiledManifestForFingerprint } from "#internal/compiled-manifest-fingerprint.js";
const MATERIALIZED_MODULES_DIRECTORY = `authored-modules`,
  MATERIALIZED_MODULES_INDEX = `authored-modules.json`;
async function prepareMaterializedAuthoredModules(e) {
  let t = await bundleAuthoredModuleMapForGeneration(e),
    n = resolveInstrumentationLayout({
      agentRoot: e.manifest.agentRoot,
      providersEnabled:
        e.manifest.config.experimental?.instrumentationProviders ?? !1,
    }),
    r = e.manifest.config.build?.externalDependencies ?? [],
    bundleInstrumentationModule = async (e) =>
      await bundleAuthoredModuleForGeneration(e, { externalDependencies: r }),
    i;
  if (n?.kind === `file`)
    i = {
      kind: `file`,
      moduleCode: await bundleInstrumentationModule(n.modulePath),
    };
  else if (n?.kind === `directory`) {
    let e = {};
    for (let [t, r] of Object.entries(n.modulePathsBySlot))
      e[t] = await bundleInstrumentationModule(r);
    i = { kind: `directory`, moduleCodeBySlot: e };
  }
  return i === void 0
    ? { moduleMapCode: t }
    : { instrumentation: i, moduleMapCode: t };
}
async function writeMaterializedAuthoredModules(t) {
  let r = join(t.runtimeAppRoot, `.eve`, `compile`),
    i = await readCompiledManifest(join(r, `compiled-agent-manifest.json`)),
    a = join(r, MATERIALIZED_MODULES_DIRECTORY),
    s = createHash(`sha256`);
  (await mkdir(a, { recursive: !0 }),
    s
      .update(`manifest\0`)
      .update(
        serializeCompiledManifestForFingerprint({
          manifest: i,
          runtimeAppRoot: t.runtimeAppRoot,
        }),
      )
      .update(`\0`));
  let c = createMaterializedModuleFileName(
      ROOT_COMPILED_AGENT_NODE_ID,
      `module-map`,
      t.prepared.moduleMapCode,
    ),
    l = join(MATERIALIZED_MODULES_DIRECTORY, c);
  (await writeFile(join(a, c), t.prepared.moduleMapCode),
    s.update(`module-map\0`).update(t.prepared.moduleMapCode).update(`\0`));
  let materializeInstrumentationModule = async (e, t) => {
      let n = createMaterializedModuleFileName(
        ROOT_COMPILED_AGENT_NODE_ID,
        `instrumentation:${e}`,
        t,
      );
      return (
        await writeFile(join(a, n), t),
        s.update(`instrumentation:${e}\0`).update(t).update(`\0`),
        join(MATERIALIZED_MODULES_DIRECTORY, n)
      );
    },
    u;
  if (t.prepared.instrumentation?.kind === `file`)
    u = {
      kind: `file`,
      modulePath: await materializeInstrumentationModule(
        `file`,
        t.prepared.instrumentation.moduleCode,
      ),
    };
  else if (t.prepared.instrumentation?.kind === `directory`) {
    let e = {};
    for (let [n, r] of Object.entries(
      t.prepared.instrumentation.moduleCodeBySlot,
    ))
      e[n] = await materializeInstrumentationModule(n, r);
    u = { kind: `directory`, modulePathsBySlot: e };
  }
  await hashDirectoryIfPresent({
    fingerprint: s,
    path: join(r, `workspace-resources`),
    root: join(r, `workspace-resources`),
  });
  let d = { fingerprint: s.digest(`hex`), moduleMap: l, version: 3 };
  return (
    u !== void 0 && (d.instrumentation = u),
    await writeFile(
      join(r, MATERIALIZED_MODULES_INDEX),
      `${JSON.stringify(d)}\n`,
    ),
    d
  );
}
async function readMaterializedAuthoredModuleIndex(e) {
  let t = join(e, `.eve`, `compile`, MATERIALIZED_MODULES_INDEX);
  if (!existsSync(t)) return;
  let n = JSON.parse(await readFile(t, `utf8`));
  if (
    n.version !== 3 ||
    typeof n.fingerprint != `string` ||
    n.fingerprint.length === 0 ||
    typeof n.moduleMap != `string` ||
    n.moduleMap.length === 0 ||
    !isMaterializedInstrumentation(n.instrumentation)
  )
    throw Error(`Invalid materialized authored module index at "${t}".`);
  return n;
}
function isMaterializedInstrumentation(e) {
  if (e === void 0) return !0;
  if (typeof e != `object` || !e) return !1;
  let t = e;
  if (t.kind === `file`) return typeof t.modulePath == `string`;
  if (t.kind === `directory`) {
    let e = t.modulePathsBySlot;
    return (
      typeof e == `object` &&
      !!e &&
      Object.values(e).every((e) => typeof e == `string`)
    );
  }
  return !1;
}
async function readCompiledManifest(e) {
  let t = JSON.parse(await readFile(e, `utf8`));
  if (t.kind !== COMPILED_AGENT_MANIFEST_KIND)
    throw Error(`Invalid compiled agent manifest at "${e}".`);
  return t;
}
function createMaterializedModuleFileName(t, n, r) {
  return `${createHash(`sha256`).update(t).update(`\0`).update(n).update(`\0`).update(r).digest(`hex`)}.mjs`;
}
async function hashDirectoryIfPresent(e) {
  if (!existsSync(e.path)) return;
  let n = await lstat(e.path),
    o = toPortablePath(relative(e.root, e.path));
  if (n.isSymbolicLink()) {
    e.fingerprint
      .update(o)
      .update(`\0link\0`)
      .update(await readlink(e.path))
      .update(`\0`);
    return;
  }
  if (n.isDirectory()) {
    for (let t of (await readdir(e.path)).sort())
      await hashDirectoryIfPresent({ ...e, path: join(e.path, t) });
    return;
  }
  n.isFile() &&
    e.fingerprint
      .update(o)
      .update(`\0file\0`)
      .update(await readFile(e.path))
      .update(`\0`);
}
function toPortablePath(e) {
  return e.split(sep).join(`/`);
}
export {
  prepareMaterializedAuthoredModules,
  readMaterializedAuthoredModuleIndex,
  writeMaterializedAuthoredModules,
};
