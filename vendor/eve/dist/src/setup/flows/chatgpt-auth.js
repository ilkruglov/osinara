import { spawn } from "node:child_process";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
async function ensureChatGptAuth() {
  if ((await getDefaultCodexTokenBroker().refreshState()).kind === `ready`)
    return;
  let n = spawn(`codex`, [`login`], { stdio: `inherit` });
  if (
    (await new Promise((e, t) => {
      (n.once(`error`, t),
        n.once(`exit`, (n, r) => {
          n === 0
            ? e()
            : t(Error(`codex login failed (${r ?? n ?? `unknown`}).`));
        }));
    }),
    (await getDefaultCodexTokenBroker().refreshState()).kind !== `ready`)
  )
    throw Error(`Codex login completed without a usable ChatGPT session.`);
}
export { ensureChatGptAuth };
