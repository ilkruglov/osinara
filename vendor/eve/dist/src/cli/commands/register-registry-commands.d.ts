import { type Command } from "#compiled/commander/index.js";
import { type CliApplicationContext } from "#cli/application-command.js";
interface RegistryCommandLogger {
    error(message: string): void;
    log(message: string): void;
}
/** Registers registry installation, configuration, and discovery commands. */
export declare function registerRegistryCommands(input: {
    program: Command;
    logger: RegistryCommandLogger;
    applicationContext: CliApplicationContext;
}): void;
export {};
