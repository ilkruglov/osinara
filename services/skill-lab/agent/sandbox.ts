import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { job } from "./lib/job.js";
export default defineSandbox({
  backend: justbash({ autoInstall: false }),
  async onSession({ use }) {
    const sandbox = await use();
    for (const [path, content] of Object.entries(job().testCase.files)) await sandbox.writeTextFile({ path, content });
  },
});
