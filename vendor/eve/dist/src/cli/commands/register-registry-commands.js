import { parseSetupAnswer } from "./setup-answers.js";
import { InvalidArgumentError } from "#compiled/commander/index.js";
import { applicationCommand } from "#cli/application-command.js";
function parseSearchLimit(e) {
  if (!/^\d+$/u.test(e))
    throw new InvalidArgumentError(
      `Expected a positive integer, received "${e}".`,
    );
  let n = Number(e);
  if (n < 1 || n > 100)
    throw new InvalidArgumentError(
      `Expected a limit between 1 and 100, received "${e}".`,
    );
  return n;
}
function registerRegistryCommands(r) {
  let { applicationContext: i, logger: a, program: o } = r,
    s = applicationCommand(o.command(`add [item]`), i)
      .description(
        `Install a registry item; relative paths use the official eve registry.`,
      )
      .option(`-o, --overwrite`, `Overwrite existing files.`)
      .option(
        `--skip-install`,
        `Run the item's setup flow without installing it.`,
      )
      .option(`--skip-setup`, `Skip the item's setup flow.`)
      .option(
        `--non-interactive`,
        `Run without interactive prompts, instead emit structured NDJSON when further input is required`,
      )
      .option(
        `--answer <key=value>`,
        `Answer a setup question with JSON; requires --non-interactive; repeat for multiple answers.`,
        parseSetupAnswer,
      )
      .option(`-y, --yes`, `Run setup and accept its recommended defaults.`)
      .addHelpText(
        `after`,
        `
Search the registry:
  $ eve registry search <query>
`,
      )
      .action(async (e, n) => {
        if (e === void 0) {
          s.outputHelp();
          return;
        }
        if (n.answer !== void 0 && !n.nonInteractive)
          throw new InvalidArgumentError(
            `--answer requires --non-interactive.`,
          );
        let { runAddCommand: r } = await import(`./registry.js`);
        await r(a, i.root, e, { ...n, answers: n.answer });
      }),
    c = o
      .command(`registry`)
      .description(
        `Configure and browse extension and agent registry catalogs.`,
      );
  (applicationCommand(c.command(`add <registries...>`), i)
    .description(`Add registry namespace mappings to package.json.`)
    .action(async (e) => {
      let { runRegistryAddCommand: t } = await import(`./registry.js`);
      await t(a, i.root, e);
    }),
    applicationCommand(c.command(`list`), i)
      .description(`List items from all registries or one source.`)
      .option(`-r, --registry <source>`, `List items from one registry.`)
      .option(`--json`, `Output as JSON`)
      .action(async (e) => {
        let { runRegistryListCommand: t } = await import(`./registry.js`);
        await t(a, i.root, e.registry, e);
      }),
    applicationCommand(c.command(`search <query>`), i)
      .description(`Search all registries or one source.`)
      .option(`-r, --registry <source>`, `Search one registry.`)
      .option(
        `--limit <count>`,
        `Maximum results to return (default: 10).`,
        parseSearchLimit,
        10,
      )
      .option(`--json`, `Output as JSON`)
      .action(async (e, t) => {
        let { runRegistrySearchCommand: n } = await import(`./registry.js`);
        await n(a, i.root, e, t.registry, t);
      }),
    applicationCommand(c.command(`view <item>`), i)
      .description(`Inspect one registry item.`)
      .option(`--json`, `Output the raw registry item as JSON.`)
      .action(async (e, t) => {
        let { runRegistryViewCommand: n } = await import(`./registry.js`);
        await n(a, i.root, e, t);
      }));
}
export { registerRegistryCommands };
