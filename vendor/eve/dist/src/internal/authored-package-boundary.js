import { isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
const CACHED_CHANNEL_PREFIX = `eve-cached-channel:`,
  RESOLVE_EXTENSIONS = [
    `.ts`,
    `.tsx`,
    `.mts`,
    `.cts`,
    `.js`,
    `.jsx`,
    `.mjs`,
    `.cjs`,
    `.json`,
  ];
function createGenerationPackageBoundaryPlugin(e) {
  return {
    name: `eve-generation-package-boundary`,
    async resolveId(t, n, r) {
      if (
        isPackageImport(t) &&
        (isFrameworkRuntimeImport(t, n) ||
          (await resolveConfiguredExternalModule.call(this, {
            externalDependencies: e.externalDependencies,
            importer: n,
            kind: r.kind,
            packageRoot: e.packageRoot,
            source: t,
          })) !== void 0)
      )
        return { external: !0, id: t };
    },
  };
}
function createRuntimeLoaderPackageBoundaryPlugin(e) {
  let t = toCanonicalPath(e.packageRoot);
  return {
    name: `eve-runtime-loader-package-boundary`,
    async resolveId(n, i, a) {
      if (!isPackageImport(n)) return;
      if (isFrameworkRuntimeImport(n, i)) return { external: !0, id: n };
      let o = await resolveConfiguredExternalModule.call(this, {
        externalDependencies: e.externalDependencies,
        importer: i,
        kind: a.kind,
        packageRoot: e.packageRoot,
        source: n,
      });
      if (o !== void 0)
        return {
          external: !0,
          id: normalizeEsmImportSpecifier(
            resolveExistingExternalFilePath(o.resolvedId) ?? o.resolvedId,
          ),
        };
      let s =
        i === void 0 ||
        i.startsWith(`\0`) ||
        i.startsWith(`eve-cached-channel:`)
          ? void 0
          : resolve(i);
      if (s !== void 0 && isPathInsideOrEqual(toCanonicalPath(s), t)) {
        let e = await this.resolve(n, i, { kind: a.kind, skipSelf: !0 });
        if (e === null || typeof e.id != `string`)
          throw Error(
            `Cannot resolve package "${n}" imported from "${s}". Install it with your package manager (e.g. \`pnpm install\`); a running \`eve dev\` retries on the next rebuild.`,
          );
        if (isNodeModulesPath(e.id)) return { external: !0, id: n };
      }
    },
  };
}
function createDistributionPackageBoundaryPlugin(t) {
  let r = new Set(t.runtimeDependencies);
  return {
    name: `eve-extension-distribution-package-boundary`,
    async resolveId(i, a, o) {
      if (!isPackageImport(i)) return;
      if (i.startsWith(`#`)) {
        let e = await this.resolve(i, a, { kind: o.kind, skipSelf: !0 });
        if (
          e !== null &&
          typeof e.id == `string` &&
          !isPathInsideOrEqual(
            toCanonicalPath(e.id),
            toCanonicalPath(t.packageRoot),
          )
        ) {
          let t = nearestPackageName(e.id);
          if (t !== void 0 && !r.has(t))
            throw Error(
              `Package import "${i}" resolves to undeclared package "${t}". Add "${t}" to dependencies, optionalDependencies, or peerDependencies.`,
            );
        }
        return;
      }
      if (isBuiltin(i)) return { external: !0, id: i };
      let s = packageImportName(i);
      if (!r.has(s))
        throw Error(
          `Package "${i}" is not declared by the extension. Add "${s}" to dependencies, optionalDependencies, or peerDependencies.`,
        );
      let c = await this.resolve(i, a, { kind: o.kind, skipSelf: !0 });
      if (
        (c === null &&
          (c = await this.resolve(i, join(t.packageRoot, `package.json`), {
            kind: o.kind,
            skipSelf: !0,
          })),
        c === null || typeof c.id != `string`)
      )
        throw Error(
          `Cannot resolve declared package "${i}". Install the extension's dependencies before building.`,
        );
      return { external: !0, id: i };
    },
  };
}
async function resolveConfiguredExternalModule(e) {
  let t = resolveConfiguredExternalDependency(e.source, e.externalDependencies);
  if (t === void 0) return;
  let r = await this.resolve(e.source, e.importer, {
    kind: e.kind,
    skipSelf: !0,
  });
  if (
    (r === null &&
      (r = await this.resolve(e.source, join(e.packageRoot, `package.json`), {
        kind: e.kind,
        skipSelf: !0,
      })),
    r === null || typeof r.id != `string`)
  )
    throw Error(`Cannot resolve external package "${e.source}".`);
  return { packageName: t, resolvedId: r.id };
}
function normalizeExternalDependencies(e = []) {
  return [...new Set(e)].sort();
}
function resolveConfiguredExternalDependency(e, t) {
  return t.find((t) => e === t || e.startsWith(`${t}/`));
}
function packageImportName(e) {
  return e.startsWith(`@`) ? e.split(`/`, 2).join(`/`) : e.split(`/`, 1)[0];
}
function nearestPackageName(e) {
  let r = dirname(toCanonicalPath(e));
  for (;;) {
    let e = join(r, `package.json`);
    if (existsSync(e))
      try {
        let t = JSON.parse(readFileSync(e, `utf8`));
        return typeof t.name == `string` && t.name.length > 0 ? t.name : void 0;
      } catch {
        return;
      }
    let i = dirname(r);
    if (i === r) return;
    r = i;
  }
}
function resolveExistingExternalFilePath(e) {
  if (existsSync(e)) return e;
  for (let t of RESOLVE_EXTENSIONS) {
    let n = `${e}${t}`;
    if (existsSync(n)) return n;
  }
}
function isPackageImport(e) {
  return isPathImport(e) || /^(?:node|data|file):/.test(e) || e.startsWith(`@/`)
    ? !1
    : !e.startsWith(CACHED_CHANNEL_PREFIX);
}
function isPathImport(e) {
  return e.startsWith(`.`) || e.startsWith(`/`) || /^[A-Za-z]:[\\/]/.test(e);
}
function isFrameworkRuntimeImport(e, t) {
  return e === `eve` || e.startsWith(`eve/`)
    ? !0
    : e === `workflow` ||
        e.startsWith(`workflow/`) ||
        e.startsWith(`@workflow/`)
      ? t === void 0 || !isNodeModulesPath(t)
      : !1;
}
function isNodeModulesPath(e) {
  return e.replaceAll(`\\`, `/`).includes(`/node_modules/`);
}
function toCanonicalPath(e) {
  try {
    return realpathSync(e);
  } catch {
    return resolve(e);
  }
}
function isPathInsideOrEqual(e, t) {
  let n = resolve(e),
    a = resolve(t);
  return n === a || n.startsWith(`${a}${sep}`);
}
export {
  CACHED_CHANNEL_PREFIX,
  RESOLVE_EXTENSIONS,
  createDistributionPackageBoundaryPlugin,
  createGenerationPackageBoundaryPlugin,
  createRuntimeLoaderPackageBoundaryPlugin,
  isNodeModulesPath,
  isPathImport,
  normalizeExternalDependencies,
};
