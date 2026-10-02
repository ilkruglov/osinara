import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toErrorMessage } from "#shared/errors.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";
import { normalizeSandboxDefinition } from "#internal/authored-definition/sandbox.js";
async function compileSandboxDefinition(e, t, n = {}) {
  let r = `Expected the sandbox export "${t.exportName ?? `default`}" from "${t.logicalPath}" to match the public eve shape.`,
    o = await loadModuleBackedDefinition({
      agentRoot: e,
      externalDependencies: n.externalDependencies,
      kind: `sandbox`,
      source: t,
    }),
    s = await resolveParentSandboxSelector(o, r),
    c = normalizeSandboxDefinition(s ? {} : o, r),
    l =
      c.revalidationKey === void 0
        ? void 0
        : await resolveSandboxRevalidationKey({
            message: r,
            revalidationKey: c.revalidationKey,
            source: t,
          });
  return {
    backendName: resolveCompiledBackendName(c.backend),
    description: c.description,
    inheritsParent: s || void 0,
    exportName: t.exportName,
    logicalPath: t.logicalPath,
    revalidationKey: l,
    sourceHash: await resolveSandboxSourceHash(e, t),
    sourceId: t.sourceId,
    sourceKind: `module`,
  };
}
const PARENT_SANDBOX_VALUE = Object.freeze({
  __eveSandboxParentValue: Symbol(`parent`),
});
async function resolveParentSandboxSelector(e, t) {
  if (typeof e != `function`) return !1;
  let n;
  try {
    n = await e({ parent: { sandbox: PARENT_SANDBOX_VALUE } });
  } catch (e) {
    throw Error(
      `${t} The callback passed to defineSandbox(...) threw while selecting parent.sandbox: ${toErrorMessage(e)}`,
    );
  }
  if (n !== PARENT_SANDBOX_VALUE)
    throw Error(
      `${t} The callback passed to defineSandbox(...) must return parent.sandbox. Export a sandbox definition object for an independent sandbox.`,
    );
  return !0;
}
function resolveCompiledBackendName(e) {
  if (e !== void 0)
    try {
      return e.name;
    } catch {
      return;
    }
}
async function resolveSandboxRevalidationKey(e) {
  let t;
  try {
    t = await e.revalidationKey();
  } catch (t) {
    throw Error(
      `${e.message} Failed to execute the "revalidationKey" function from "${e.source.logicalPath}": ${toErrorMessage(t)}`,
    );
  }
  if (typeof t != `string`)
    throw Error(
      `${e.message} The "revalidationKey" function must return a string.`,
    );
  if (t.trim().length === 0)
    throw Error(
      `${e.message} The "revalidationKey" function must return a non-empty string.`,
    );
  return t;
}
async function resolveSandboxSourceHash(r, i) {
  let a = await readFile(join(r, i.logicalPath));
  return createHash(`sha256`).update(a).digest(`hex`);
}
export { compileSandboxDefinition, resolveParentSandboxSelector };
