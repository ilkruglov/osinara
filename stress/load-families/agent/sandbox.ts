/** The production sandbox hook over an in-process filesystem; sandbox containers are measured apart. */
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import productionSandbox from "../../../agent/sandbox.js";

export default defineSandbox({
  backend: justbash(),
  async onSession(input) {
    if (!productionSandbox.onSession) throw new Error("LOAD_SANDBOX_HOOK_MISSING");
    // The production hook asks for workspace mounts; just-bash runs them in-process.
    await productionSandbox.onSession(input as unknown as Parameters<typeof productionSandbox.onSession>[0]);
  },
});
