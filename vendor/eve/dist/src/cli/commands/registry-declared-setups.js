import {
  headlessSetupContinuation,
  serializeHeadlessSetupEvent,
} from "./setup-headless.js";
import { createPrompter } from "#setup/prompter.js";
import { createHeadlessPrompter } from "#setup/headless.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
async function runDeclaredSetups(i) {
  let a = { facts: [] };
  if (i.setups === void 0) return a;
  let o = await i.dependencies.loadSetupCommandRunner(),
    s =
      i.options.prompter ??
      (i.options.nonInteractive
        ? createHeadlessPrompter(i.logger.log)
        : createPrompter());
  try {
    for (let n of i.setups) {
      let r = await o(
        i.appRoot,
        {
          ...n,
          args: [
            ...n.args,
            ...(i.options.yes ? [`--yes`] : []),
            ...(i.options.nonInteractive ? [`--non-interactive`] : []),
            ...Object.entries(i.options.answers ?? {}).flatMap(([e, t]) => [
              `--answer`,
              `${e}=${JSON.stringify(t)}`,
            ]),
          ],
        },
        i.item,
        { prompter: s, signal: i.options.signal },
      );
      if (r.kind === `cancelled`)
        return (i.logger.log(i.cancelledReminder), !1);
      if (r.kind === `blocked`) {
        if (!i.options.nonInteractive)
          throw Error(`Setup requires more input.`);
        return (
          i.logger.error(
            serializeHeadlessSetupEvent({
              version: 1,
              type: `blocked`,
              item: i.item,
              installed: !0,
              completedItems: [],
              ...r.blocker,
              next: headlessSetupContinuation({
                item: i.item,
                installed: !0,
                question:
                  r.blocker.status === `input_required`
                    ? r.blocker.question
                    : void 0,
              }),
            }),
          ),
          (process.exitCode = 2),
          !1
        );
      }
      if (i.options.silent !== !0)
        for (let e of r.facts) i.logger.log(`${e.label}: ${e.value}`);
      a = mergeRegistrySetupCompletions(a, r);
    }
    return a;
  } catch (n) {
    let r = n instanceof Error ? n.message : String(n);
    if (i.options.nonInteractive)
      return (
        i.logger.error(
          serializeHeadlessSetupEvent({
            version: 1,
            type: `failed`,
            item: i.item,
            completedItems: [],
            message: r,
            next: headlessSetupContinuation({ item: i.item, installed: !0 }),
          }),
        ),
        (process.exitCode = 1),
        !1
      );
    throw Error(`${r} Try again with \`${i.resumeCommand}\`.`);
  }
}
export { runDeclaredSetups };
