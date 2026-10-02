import type { Command } from "#compiled/commander/index.js";
import { type CliApplicationContext } from "#cli/application-command.js";
interface ProjectCommandLogger {
    error(message: string): void;
    log(message: string): void;
}
/** Registers project-level Vercel commands without eagerly loading their flows. */
export declare function registerProjectCommands(input: {
    program: Command;
    logger: ProjectCommandLogger;
    applicationContext: CliApplicationContext;
}): void;
export {};
