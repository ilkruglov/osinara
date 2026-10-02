import { parseRegistryPresentationManifest } from "./registry-metadata.js";
import { createCliTheme, sanitizeForTerminal } from "#cli/ui/output.js";
import { clipVisible, wrapVisibleLine } from "#cli/ui/terminal-text.js";
function normalizeRegistryText(e) {
  return sanitizeForTerminal(e)
    .replaceAll(`\\"`, `"`)
    .replaceAll(`\\'`, `'`)
    .replaceAll(/\s+/gu, ` `)
    .trim();
}
function registryDescriptionSummary(e) {
  let t = normalizeRegistryText(e);
  return t.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? t;
}
function renderSearchItem(e, t, n) {
  let a = Math.max(1, t - 4),
    o = wrapVisibleLine(normalizeRegistryText(e.address), a),
    s =
      e.implementation === `native`
        ? `First-class eve channel`
        : e.implementation === `chat-sdk`
          ? `Chat SDK adapter`
          : void 0,
    c = normalizeRegistryText(e.item.name),
    l = c.split(`/`).at(-1) ?? c,
    u = [
      `  ${n.label(l)}${s === void 0 ? `` : n.muted(` · ${s}`)}`,
      ...o.map((e) => `    ${e}`),
    ];
  if (!e.item.description)
    return u.join(`
`);
  let d = registryDescriptionSummary(e.item.description);
  if (d.length === 0)
    return u.join(`
`);
  let f = wrapVisibleLine(d, a),
    p =
      f.length <= 2
        ? f
        : [f[0], `${clipVisible(f[1], Math.max(1, a - 1)).trimEnd()}…`];
  return (
    u.push(...p.map((e) => n.muted(`    ${e}`))),
    u.join(`
`)
  );
}
function printRegistrySearchResults(e, n) {
  if (n.json !== void 0) {
    e.log(JSON.stringify(n.json, null, 2));
    return;
  }
  if (n.sections.every((e) => e.items.length === 0)) {
    let t = n.query && normalizeRegistryText(n.query);
    e.log(t ? `No registry items match "${t}".` : `No registry items found.`);
    return;
  }
  let r = createCliTheme(),
    i = Math.max(20, process.stdout.columns ?? 80),
    a = n.sections.flatMap((e) => {
      if (e.items.length === 0) return [];
      let t = `${e.total} result${e.total === 1 ? `` : `s`}`,
        n = e.items.length < e.total ? `showing ${e.items.length} of ${t}` : t;
      return [
        [
          `${r.label(e.label)} ${r.muted(`(${n})`)}`,
          ...e.items.map((e) => renderSearchItem(e, i, r)),
        ].join(`
`),
      ];
    });
  e.log(
    a.join(`
`),
  );
}
function registryViewText(t, n) {
  let r = parseRegistryPresentationManifest(n);
  if (r === void 0) return JSON.stringify(n, null, 2);
  let i = r.meta?.eve,
    a = [r.title ?? t, t];
  if (
    (r.description !== void 0 && a.push(``, r.description),
    i?.implementation !== void 0 &&
      a.push(
        ``,
        `Implementation  ${i.implementation === `native` ? `First-class eve channel` : `Chat SDK adapter`}`,
      ),
    i?.setup !== void 0 && a.push(`Setup           Guided setup`),
    i?.docs !== void 0)
  ) {
    let e = i.docs.startsWith(`/`) ? `https://eve.dev${i.docs}` : i.docs;
    a.push(`Documentation   ${e}`);
  }
  (a.push(`Source          Official eve registry`),
    r.dependencies?.length &&
      a.push(``, `Packages`, ...r.dependencies.map((e) => `  ${e}`)));
  let o = r.files?.map((e) => e.target) ?? [];
  return (
    o.length > 0 && a.push(``, `Files`, ...o.map((e) => `  ${e}`)),
    a.join(`
`)
  );
}
export { normalizeRegistryText, printRegistrySearchResults, registryViewText };
