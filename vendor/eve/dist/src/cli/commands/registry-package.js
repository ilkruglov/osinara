import { hasInteractiveTerminal } from "./preconditions.js";
import {
  headlessSetupContinuation,
  serializeHeadlessSetupEvent,
} from "./setup-headless.js";
import { z } from "#compiled/zod/index.js";
import { createPrompter } from "#setup/prompter.js";
import {
  headlessAsker,
  interactiveAsker,
  withAnswers,
  withPolicy,
} from "#setup/ask.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import {
  addRegistryItems,
  getRegistryItems,
} from "#compiled/shadcn-registry/index.js";
const RegistryPackageComponentSchema = z.object({
  item: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().default(!1),
});
async function selectComponents(e, r, i, l, u, d) {
  if (l.prompter === void 0 && !l.nonInteractive && (l.yes === !0 || !u))
    return i.filter((e) => e.default);
  let f = {
      key: `components`,
      message: `Add ${r}`,
      required: !0,
      recommended: i.filter((e) => e.default),
      options: i.map((e) => ({
        id: e.item,
        value: e,
        label: e.label,
        hint: e.description,
      })),
    },
    p = l.nonInteractive
      ? withAnswers(l.answers ?? {})(
          l.yes ? withPolicy(`assume`)(headlessAsker()) : headlessAsker(),
        )
      : interactiveAsker(d());
  try {
    return await p.askMany(f);
  } catch (i) {
    if (
      !l.nonInteractive ||
      !(i instanceof Error) ||
      i.name !== `InteractionRequired`
    )
      throw i;
    let a = i.question,
      { setupQuestionToWire: o } = await import(
        `#setup/setup-question-wire.js`
      ),
      s = o(a);
    (e.error(
      serializeHeadlessSetupEvent({
        version: 1,
        type: `blocked`,
        status: `input_required`,
        item: r,
        installed: !1,
        completedItems: [],
        question: s,
        next: headlessSetupContinuation({
          item: r,
          installed: !1,
          question: s,
        }),
      }),
    ),
      (process.exitCode = 2));
    return;
  }
}
async function runRegistryPackage(t) {
  let {
      logger: n,
      appRoot: r,
      item: a,
      components: o,
      config: s,
      options: c,
      dependencies: f,
      operations: p,
    } = t,
    m = f.hasInteractiveTerminal?.() ?? hasInteractiveTerminal(),
    h = c.prompter,
    getPrompter = () => (h ??= f.createPrompter?.() ?? createPrompter()),
    g = await selectComponents(n, a, o, c, m, getPrompter);
  if (g === void 0) return !1;
  let _ = g.map((e) => p.itemAddress(e.item)),
    v = await getRegistryItems(_, { config: s });
  if (v.length !== g.length)
    throw Error(
      `Registry package "${a}" could not resolve all selected components.`,
    );
  let y = v.map((e) => {
    let t = p.metadata(e);
    return (p.assertCompatibleVersion(t?.requires), t);
  });
  c.skipInstall !== !0 &&
    (await addRegistryItems(_, {
      config: s,
      cwd: r,
      overwrite: c.overwrite,
      silent: c.silent,
    }));
  let b = { facts: [] };
  if (c.skipSetup === !0) return b;
  if (!c.nonInteractive && c.yes !== !0 && c.prompter === void 0 && !m)
    return (n.log(p.setupReminder(a)), b);
  for (let e of y) {
    if (e?.setup === void 0) continue;
    let t = await p.runSetups({
      item: a,
      setups: e.setup,
      prompter: getPrompter(),
    });
    if (t === !1) return !1;
    b = mergeRegistrySetupCompletions(b, t);
  }
  return b;
}
export { RegistryPackageComponentSchema, runRegistryPackage };
