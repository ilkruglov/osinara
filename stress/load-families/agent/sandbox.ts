/**
 * The production sandbox hook over an in-process filesystem by default; with LOAD_REAL_SANDBOX=1
 * the production backend itself (Docker containers through the sandbox runner), to measure them.
 */
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import productionSandbox from "../../../agent/sandbox.js";

const inProcess = defineSandbox({
  backend: justbash(),
  async onSession(input) {
    if (!productionSandbox.onSession) throw new Error("LOAD_SANDBOX_HOOK_MISSING");
    // The production hook asks for workspace mounts; just-bash runs them in-process.
    await productionSandbox.onSession(input as unknown as Parameters<typeof productionSandbox.onSession>[0]);
  },
});

export default process.env.LOAD_REAL_SANDBOX === "1" ? productionSandbox : inProcess;
