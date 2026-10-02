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
function renderSearchItem(e, t, i, a) {
  let o = Math.max(1, i - 4),
    s = wrapVisibleLine(normalizeRegistryText(t), o),
    c = normalizeRegistryText(e.name),
    l = c.split(`/`).at(-1) ?? c,
    u = [`  ${a.label(l)}`, ...s.map((e) => `    ${e}`)];
  if (!e.description)
    return u.join(`
`);
  let d = registryDescriptionSummary(e.description);
  if (d.length === 0)
    return u.join(`
`);
  let f = wrapVisibleLine(d, o),
    p =
      f.length <= 2
        ? f
        : [f[0], `${clipVisible(f[1], Math.max(1, o - 1)).trimEnd()}…`];
  return (
    u.push(...p.map((e) => a.muted(`    ${e}`))),
    u.join(`
`)
  );
}
function printRegistrySearchResults(t, n, r) {
  if (r.json) {
    t.log(JSON.stringify(n, null, 2));
    return;
  }
  if (n.items.length === 0) {
    let e = r.query && normalizeRegistryText(r.query);
    t.log(e ? `No registry items match "${e}".` : `No registry items found.`);
    return;
  }
  let i = createCliTheme(),
    a = Math.max(20, process.stdout.columns ?? 80),
    o = r.sections.flatMap((e) => {
      if (e.items.length === 0) return [];
      let t = `${e.total} result${e.total === 1 ? `` : `s`}`,
        n = e.items.length < e.total ? `showing ${e.items.length} of ${t}` : t;
      return [
        [
          `${i.label(e.label)} ${i.muted(`(${n})`)}`,
          ...e.items.map((t) => renderSearchItem(t, e.address(t), a, i)),
        ].join(`
`),
      ];
    });
  t.log(
    o.join(`
`),
  );
}
export { normalizeRegistryText, printRegistrySearchResults };
