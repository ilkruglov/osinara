import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
function createExtensionExternalDependencyPlugin(e) {
  let t = collectDependencyAnchors(e);
  return t.size === 0
    ? null
    : {
        name: `eve-extension-external-dependency`,
        resolveId(e) {
          return [...t.keys()].find((t) => e === t || e.startsWith(`${t}/`)) ===
            void 0
            ? null
            : { external: !0, id: e };
        },
      };
}
function resolveExtensionExternalDependencyPaths(e) {
  let t = {};
  for (let [n, r] of collectDependencyAnchors(e)) {
    for (let e of r)
      try {
        t[n] = resolveDependencyEntry(n, e);
        break;
      } catch {}
    if (t[n] === void 0)
      throw Error(
        `Cannot resolve extension external dependency "${n}" from its mounted extension package.`,
      );
  }
  return t;
}
function resolveDependencyEntry(a, o) {
  let s = createRequire(o);
  try {
    return s.resolve(a);
  } catch (e) {
    let o = s.resolve
      .paths(a)
      ?.map((e) => join(e, a, `package.json`))
      .find(existsSync);
    if (o === void 0) throw e;
    let c = JSON.parse(readFileSync(o, `utf8`)),
      l =
        resolveImportExport(c.exports) ??
        stringValue(c.module) ??
        stringValue(c.main);
    if (l === void 0) throw e;
    return resolve(dirname(o), l);
  }
}
function resolveImportExport(e) {
  if (typeof e == `string`) return e;
  if (Array.isArray(e))
    return e.map(resolveImportExport).find((e) => e !== void 0);
  if (typeof e != `object` || !e) return;
  let t = e;
  if (`.` in t) return resolveImportExport(t[`.`]);
  for (let e of [`node`, `import`, `default`]) {
    let n = resolveImportExport(t[e]);
    if (n !== void 0) return n;
  }
}
function stringValue(e) {
  return typeof e == `string` ? e : void 0;
}
function collectDependencyAnchors(e) {
  let t = new Map();
  for (let r of e)
    for (let e of r.externalDependencies) {
      let i = t.get(e) ?? [];
      (i.push(join(realpathSync(r.sourceRoot), `_manifest.json`)), t.set(e, i));
    }
  return t;
}
export {
  createExtensionExternalDependencyPlugin,
  resolveExtensionExternalDependencyPaths,
};
