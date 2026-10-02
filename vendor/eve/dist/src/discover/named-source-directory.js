import { join } from "node:path";
import {
  getDirectoryEntryType,
  getSupportedModuleBaseName,
  isTypeScriptDeclarationFileName,
  normalizeLogicalPath,
} from "#discover/filesystem.js";
import { createDiscoverErrorDiagnostic } from "#discover/diagnostics.js";
import { createModuleSourceRef } from "#discover/manifest.js";
import {
  createModuleSlotCollisionDiagnostic,
  createSlotCollisionDiagnostic,
  readSortedDirectoryEntries,
} from "#discover/grammar.js";
import { collectNamedSlotCandidates } from "#discover/slots.js";
import { discoverMarkdownSource } from "#discover/markdown.js";
async function discoverNamedSourceDirectory(t) {
  let n = join(t.rootPath, t.directoryName),
    r = t.rootEntries.find((e) => e.name === t.directoryName);
  if (r === void 0) return { diagnostics: [], sources: [] };
  if (!r.isDirectory())
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: t.invalidDirectoryCode,
          message: t.invalidDirectoryMessage,
          sourcePath: n,
        }),
      ],
      sources: [],
    };
  let i = [],
    o = [];
  return (
    await walkNamedSourceDirectory({
      allowMarkdown: t.allowMarkdown === !0,
      diagnostics: i,
      markdownLowerer: t.allowMarkdown === !0 ? t.markdownLowerer : void 0,
      projectSource: t.source,
      recursive: t.recursive,
      relativeDirectory: t.directoryName,
      rootDirectoryPath: n,
      sources: o,
      subdirectoryRelative: ``,
      unsupportedEntryCode: t.unsupportedEntryCode,
      unsupportedEntryMessage: t.unsupportedEntryMessage,
      unsupportedFileCode: t.unsupportedFileCode,
      unsupportedFileMessage: t.unsupportedFileMessage,
      validateSegment: t.validateSegment,
    }),
    { diagnostics: i, sources: o }
  );
}
async function walkNamedSourceDirectory(t) {
  let n =
      t.subdirectoryRelative === ``
        ? t.rootDirectoryPath
        : join(t.rootDirectoryPath, t.subdirectoryRelative),
    r = await readSortedDirectoryEntries(t.projectSource, n);
  (t.recursive && (await walkSubdirectories(t, r, n)),
    (t.unsupportedFileCode !== void 0 || t.unsupportedEntryCode !== void 0) &&
      emitUnsupportedLeafDiagnostics(t, r, n),
    await collectLeafSources(t, r, n));
}
async function walkSubdirectories(t, n, r) {
  for (let i of n) {
    if (!i.isDirectory()) continue;
    let n = join(r, i.name);
    if (t.validateSegment !== void 0) {
      let e = t.validateSegment(i.name, n);
      if (e !== null) {
        t.diagnostics.push(e);
        continue;
      }
    }
    await walkNamedSourceDirectory({
      allowMarkdown: t.allowMarkdown,
      diagnostics: t.diagnostics,
      markdownLowerer: t.markdownLowerer,
      projectSource: t.projectSource,
      recursive: t.recursive,
      relativeDirectory: t.relativeDirectory,
      rootDirectoryPath: t.rootDirectoryPath,
      sources: t.sources,
      subdirectoryRelative:
        t.subdirectoryRelative === ``
          ? i.name
          : join(t.subdirectoryRelative, i.name),
      unsupportedEntryCode: t.unsupportedEntryCode,
      unsupportedEntryMessage: t.unsupportedEntryMessage,
      unsupportedFileCode: t.unsupportedFileCode,
      unsupportedFileMessage: t.unsupportedFileMessage,
      validateSegment: t.validateSegment,
    });
  }
}
function emitUnsupportedLeafDiagnostics(i, o, s) {
  for (let c of o) {
    let o = getDirectoryEntryType(c),
      l = join(s, c.name);
    if (o === `directory`) continue;
    if (o === `other`) {
      i.unsupportedEntryCode !== void 0 &&
        i.diagnostics.push(
          createDiscoverErrorDiagnostic({
            code: i.unsupportedEntryCode,
            message:
              i.unsupportedEntryMessage?.(l, i.relativeDirectory) ??
              `Expected "${l}" to be a regular file or directory within "${i.relativeDirectory}/".`,
            sourcePath: l,
          }),
        );
      continue;
    }
    if (
      i.unsupportedFileCode === void 0 ||
      isTypeScriptDeclarationFileName(c.name)
    )
      continue;
    let u = getSupportedModuleBaseName(c.name) !== null,
      d = i.allowMarkdown && c.name.endsWith(`.md`);
    u ||
      d ||
      i.diagnostics.push(
        createDiscoverErrorDiagnostic({
          code: i.unsupportedFileCode,
          message:
            i.unsupportedFileMessage?.(l, i.relativeDirectory) ??
            `Expected "${l}" to be a supported authored source within "${i.relativeDirectory}/".`,
          sourcePath: l,
        }),
      );
  }
}
async function collectLeafSources(t, n, r) {
  for (let a of collectNamedSlotCandidates(n, {
    allowMarkdown: t.allowMarkdown,
    allowModules: !0,
  })) {
    let n =
        t.subdirectoryRelative === ``
          ? a.slotName
          : join(t.subdirectoryRelative, a.slotName),
      l = normalizeLogicalPath(join(t.relativeDirectory, n));
    if (t.validateSegment !== void 0) {
      let n = a.markdownFileName ?? a.moduleFileNames[0] ?? a.slotName,
        i = t.validateSegment(a.slotName, join(r, n));
      if (i !== null) {
        t.diagnostics.push(i);
        continue;
      }
    }
    if (a.markdownFileName !== void 0 && a.moduleFileNames.length > 0) {
      t.diagnostics.push(
        createSlotCollisionDiagnostic(r, l, [
          a.markdownFileName,
          ...a.moduleFileNames,
        ]),
      );
      continue;
    }
    if (a.moduleFileNames.length > 1) {
      t.diagnostics.push(
        createModuleSlotCollisionDiagnostic(r, l, a.moduleFileNames),
      );
      continue;
    }
    if (a.markdownFileName !== void 0) {
      let n =
          t.subdirectoryRelative === ``
            ? a.markdownFileName
            : join(t.subdirectoryRelative, a.markdownFileName),
        r = normalizeLogicalPath(join(t.relativeDirectory, n));
      if (t.markdownLowerer === void 0) continue;
      let o = await discoverMarkdownSource({
        logicalPath: r,
        lower: t.markdownLowerer,
        source: t.projectSource,
        sourcePath: join(t.rootDirectoryPath, n),
      });
      t.sources.push(o);
      continue;
    }
    let [u] = a.moduleFileNames;
    if (u === void 0) continue;
    let f = t.subdirectoryRelative === `` ? u : join(t.subdirectoryRelative, u);
    t.sources.push(
      createModuleSourceRef({
        logicalPath: normalizeLogicalPath(join(t.relativeDirectory, f)),
      }),
    );
  }
}
export { discoverNamedSourceDirectory };
