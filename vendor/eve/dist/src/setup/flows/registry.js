import { createRegistrySession } from "./registry-session.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import { WizardCancelledError } from "#setup/step.js";
import { detectDeployment } from "#setup/project-resolution.js";
import { withSpinner } from "#setup/with-spinner.js";
const ADDRESS_PREFIX = `address:`,
  BACK = `action:back`,
  DONE = `action:done`,
  ALL = `category:all`,
  REGISTRY_CATEGORIES = [
    {
      value: `category:channel`,
      prefix: `channel/`,
      label: `Channels`,
      hint: `Where people talk to your agent — Web, Slack, Discord, Teams`,
      browseLabel: `Browse channels`,
    },
    {
      value: `category:connection`,
      prefix: `connection/`,
      label: `MCP connections`,
      hint: `Connect services like Linear, Notion, GitHub, and Vercel`,
      browseLabel: `Browse MCP connections`,
    },
    {
      value: `category:extension`,
      prefix: `extension/`,
      label: `Extensions`,
      hint: `Add browser automation, memory, and developer tools`,
      browseLabel: `Browse extensions`,
    },
    {
      value: `category:instrumentation`,
      prefix: `instrumentation/`,
      label: `Observability`,
      hint: `Trace, evaluate, and monitor your agent`,
      browseLabel: `Browse observability integrations`,
    },
  ];
var RegistryFlowFailedError = class extends Error {
  completed;
  constructor(e, t) {
    (super(e instanceof Error ? e.message : String(e), { cause: e }),
      (this.name = `RegistryFlowFailedError`),
      (this.completed = t));
  }
};
function itemLabel(e) {
  return e.title === void 0
    ? (e.name.split(`/`).at(-1) ?? e.name)
        .split(`-`)
        .map((e) => e.charAt(0).toUpperCase() + e.slice(1))
        .join(` `)
    : e.title;
}
function itemRows(e) {
  return e.map((e, t) => ({
    value: `item:${t}`,
    label: itemLabel(e),
    hint: e.description ?? e.type,
  }));
}
function categoryRows() {
  return [
    ...REGISTRY_CATEGORIES.map((e) => ({
      value: e.value,
      label: e.label,
      hint: e.hint,
    })),
    {
      value: ALL,
      label: `Browse all`,
      hint: `Search every integration or enter an item address`,
    },
    { value: DONE, label: `Return to chat`, trailingAction: !0 },
  ];
}
function categoryFor(e) {
  return REGISTRY_CATEGORIES.find((t) => t.value === e);
}
function itemsForCategory(e, t) {
  if (t === ALL) return e;
  let n = categoryFor(t);
  return n === void 0
    ? e
    : e.filter(
        (e) => e.address.startsWith(n.prefix) || e.name.startsWith(n.prefix),
      );
}
function stringArray(e) {
  return Array.isArray(e) ? e.filter((e) => typeof e == `string`) : [];
}
function itemSource(e) {
  if (e.startsWith(`@`)) return e.split(`/`)[0] ?? e;
  if (/^https?:\/\//u.test(e))
    try {
      return new URL(e).host;
    } catch {
      return e;
    }
  return `Vercel`;
}
function manifestRecord(e) {
  return typeof e == `object` && e && !Array.isArray(e) ? e : {};
}
function summarizeDetails(e, t = 3) {
  let n = e.slice(0, t),
    r = e.length - n.length;
  return r > 0 ? `${n.join(`, `)} … (+${r} more)` : n.join(`, `);
}
function itemDetails(e, t) {
  let n = [{ label: `Source`, value: e.source }],
    r = [
      ...stringArray(t.dependencies),
      ...stringArray(t.devDependencies),
      ...stringArray(t.registryDependencies),
    ];
  r.length > 0 && n.push({ label: `Packages`, value: summarizeDetails(r) });
  let i = t.envVars;
  if (typeof i == `object` && i && !Array.isArray(i)) {
    let e = Object.keys(i);
    e.length > 0 &&
      n.push({ label: `Environment`, value: summarizeDetails(e) });
  }
  let a = (Array.isArray(t.files) ? t.files : []).flatMap((e) => {
    if (typeof e != `object` || !e || Array.isArray(e)) return [];
    let t = e.target;
    return typeof t == `string` ? [t] : [];
  });
  return (
    a.length > 0 && n.push({ label: `Files`, value: summarizeDetails(a) }),
    n
  );
}
async function inspectItem(e, t, n, r, a, o) {
  let s =
    a ??
    manifestRecord(
      await withSpinner(e, `Loading registry item…`, () =>
        t.getRegistryItemManifest(n, r.address),
      ),
    );
  for (;;) {
    let i = {
        message: typeof s.title == `string` ? s.title : r.name,
        metadata: itemDetails(r, s),
        options: [
          { value: `add`, label: `Add to project` },
          { value: `back`, label: `Back` },
        ],
      },
      a = typeof s.description == `string` ? s.description : r.description;
    if ((a !== void 0 && (i.description = a), (await e.select(i)) === `back`))
      return { kind: `back` };
    let c = e.log.spinner?.(`Installing ${itemLabel(r)} and dependencies…`);
    try {
      c?.stop();
      let install = () =>
        t.installRegistryItem(n, r.address, {
          silent: !0,
          prompter: e,
          signal: o,
        });
      return {
        kind: `added`,
        ...(await (e.withExclusiveTerminal?.(install) ?? install())),
      };
    } finally {
      c?.stop();
    }
  }
}
async function resolveAddressItem(e, t, n, r) {
  let a = manifestRecord(
      await withSpinner(e, `Loading registry item…`, () =>
        t.getRegistryItemManifest(n, r),
      ),
    ),
    o = {
      address: r,
      name: typeof a.name == `string` ? a.name : r,
      source: itemSource(r),
    };
  return (
    typeof a.type == `string` && (o.type = a.type),
    typeof a.description == `string` && (o.description = a.description),
    { item: o, manifest: a }
  );
}
async function runRegistryFlow(c) {
  let l;
  (c.deps?.browseRegistryCatalog === void 0 ||
    c.deps.getRegistryItemManifest === void 0 ||
    c.deps.installRegistryItem === void 0) &&
    (l = await import(`#cli/commands/registry.js`));
  let u = {
      browseRegistryCatalog:
        c.deps?.browseRegistryCatalog ?? l.browseRegistryCatalog,
      detectDeployment: c.deps?.detectDeployment ?? detectDeployment,
      getRegistryItemManifest:
        c.deps?.getRegistryItemManifest ?? l.getRegistryItemManifest,
      installRegistryItem: c.deps?.installRegistryItem ?? l.installRegistryItem,
      runDeployFlow: c.deps?.runDeployFlow ?? runDeployFlow,
    },
    d = [],
    f = createRegistrySession(u);
  try {
    for (;;) {
      c.signal?.throwIfAborted();
      let e = await withSpinner(c.prompter, `Loading registry…`, () =>
        u.browseRegistryCatalog(c.appRoot),
      );
      d = [
        ...d,
        ...e.errors.map((e) => ({
          tone: `warning`,
          text: `${e.registry}: ${e.message}`,
        })),
      ];
      let t = await c.prompter.select({
        message: `Add an integration`,
        options: categoryRows(),
        hintLayout: `inline`,
        notices: d,
      });
      if (((d = []), t === DONE)) return f.result();
      let n = itemsForCategory(e.items, t),
        r = itemRows(n);
      r.push({ value: BACK, label: `Back`, trailingAction: !0 });
      let l = await c.prompter.select({
        message: categoryFor(t)?.browseLabel ?? `Browse integrations`,
        options: r,
        search: !0,
        placeholder: `Search integrations or enter an item address`,
        searchAction: {
          label: (e) => `Add “${e}”`,
          value: (e) => `${ADDRESS_PREFIX}${e.trim()}`,
        },
        hintLayout: `inline`,
      });
      if (l === BACK) continue;
      let p = l.startsWith(ADDRESS_PREFIX)
        ? await resolveAddressItem(c.prompter, u, c.appRoot, l.slice(8))
        : { item: n[Number(l.slice(5))] };
      if (p.item === void 0)
        throw Error(`The selected registry item is no longer available.`);
      let m = await inspectItem(
        c.prompter,
        u,
        c.appRoot,
        p.item,
        `manifest` in p ? p.manifest : void 0,
        c.signal,
      );
      if (m.kind !== `added`) continue;
      f.add(p.item.address, itemLabel(p.item), m.output, m.setup);
      let h = await f.continueAfterInstall({
        appRoot: c.appRoot,
        prompter: c.prompter,
        signal: c.signal,
      });
      if (h !== `add-more`) return h;
    }
  } catch (e) {
    if (e instanceof WizardCancelledError) return { kind: `cancelled` };
    let t = f.result();
    throw t.addedItems.length > 0 ? new RegistryFlowFailedError(e, t) : e;
  }
}
export { RegistryFlowFailedError, runRegistryFlow };
