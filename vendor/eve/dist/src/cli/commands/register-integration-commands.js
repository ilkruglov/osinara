import { parseSetupAnswer } from "./setup-answers.js";
import { applicationCommand } from "#cli/application-command.js";
function registerIntegrationCommands(n) {
  let { applicationContext: r, logger: i, program: a } = n,
    o = a.command(`integration`, { hidden: !0 });
  (applicationCommand(o.command(`setup <kind>`), r)
    .option(`-y, --yes`)
    .option(
      `--non-interactive`,
      `Run without interactive prompts, instead emit structured NDJSON when further input is required`,
    )
    .option(
      `--answer <key=value>`,
      `Answer a setup question; requires --non-interactive.`,
      parseSetupAnswer,
      {},
    )
    .action(async (e, t) => {
      let { runIntegrationSetupCommand: n } = await import(
        `./integration-setup.js`
      );
      await n(i, r.root, e, {
        yes: t.yes,
        nonInteractive: t.nonInteractive,
        answers: t.answer,
      });
    }),
    applicationCommand(
      o.command(`connect <slug> <service> [canonical-name]`),
      r,
    )
      .option(`-y, --yes`)
      .option(
        `--non-interactive`,
        `Run without interactive prompts, instead emit structured NDJSON when further input is required`,
      )
      .action(async (e, t, n, a) => {
        let { runIntegrationConnectCommand: o } = await import(
          `./integration-connect.js`
        );
        await o(i, r.root, e, t, n, a);
      }));
}
export { registerIntegrationCommands };
