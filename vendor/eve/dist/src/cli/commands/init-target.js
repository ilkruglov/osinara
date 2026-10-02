import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PROJECT_NAME_ERROR, parseProjectName } from "#setup/project-name.js";
import {
  classifyAgentRootEntry,
  getDirectoryEntryType,
} from "#discover/filesystem.js";
const ENVIRONMENT_ONLY_ENTRIES = new Set([
  `.DS_Store`,
  `.editorconfig`,
  `.gitattributes`,
  `.gitignore`,
  `.git`,
  `.idea`,
  `.vscode`,
]);
async function pathKind(e) {
  let n = await stat(e).catch((e) => {
    if (e.code !== `ENOENT`) throw e;
  });
  return n === void 0 ? `missing` : n.isDirectory() ? `directory` : `other`;
}
function isEnvironmentOnly(e) {
  return e.every((e) => ENVIRONMENT_ONLY_ENTRIES.has(e));
}
async function isAgentRoot(t) {
  return (await readdir(t, { withFileTypes: !0 }).catch(() => [])).some((e) => {
    let t = classifyAgentRootEntry(e.name, getDirectoryEntryType(e));
    return (
      t !== `unknown` && t !== `ignored-directory` && t !== `lib-directory`
    );
  });
}
async function isExistingEveProject(e, t) {
  return (await isAgentRoot(e))
    ? !0
    : (t.includes(`package.json`) || t.includes(`vercel.json`)) &&
        t.includes(`agent`) &&
        (await isAgentRoot(resolve(e, `agent`)));
}
function listEntries(e) {
  return e.map((e) => `  - ${e}`).join(`
`);
}
function assertTargetStaysWithinParent(e, t, n) {
  if (t === void 0 || isAbsolute(t)) return;
  let a = relative(e, n);
  if (a === `..` || a.startsWith(`..${sep}`)) throw Error(PROJECT_NAME_ERROR);
}
async function resolveInitTarget(t) {
  let r = resolve(t.parentDirectory),
    i = t.target !== void 0,
    o = resolve(r, t.target ?? `.`);
  assertTargetStaysWithinParent(r, t.target, o);
  let s = o === r,
    c = await pathKind(o);
  if (c === `other`)
    throw Error(
      `Cannot initialize an agent because "${o}" is not a directory.`,
    );
  if (c === `missing`)
    return {
      createInPlace: !1,
      failurePolicy: `remove`,
      kind: `fresh`,
      overwriteExisting: !1,
      preservedEntries: [],
      projectName: parseProjectName(basename(o)),
      projectPath: o,
    };
  let l = (await readdir(o)).sort();
  if (l.length === 0 || isEnvironmentOnly(l)) {
    let e = s ? `.` : parseProjectName(basename(o));
    return {
      createInPlace: s || l.length > 0,
      failurePolicy: `clear`,
      kind: `fresh`,
      overwriteExisting: !1,
      preservedEntries: l,
      projectName: e,
      projectPath: o,
    };
  }
  if (await isExistingEveProject(o, l))
    throw Error(
      `An eve project already exists at "${o}". Run an existing-project command from that directory instead.`,
    );
  if (l.includes(`package.json`)) {
    if (!i || t.target !== `.`)
      throw Error(
        `Adding eve to an existing package requires an explicit \`eve init .\` from "${o}".`,
      );
    return { kind: `existing`, projectPath: o };
  }
  throw Error(
    `Cannot initialize an agent in the non-empty directory "${o}". Move or remove these entries, or choose an empty target:\n${listEntries(l)}`,
  );
}
export { resolveInitTarget };
