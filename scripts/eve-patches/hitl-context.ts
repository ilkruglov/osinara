import { resolve } from "node:path";
export async function patchHitlContext(replace: (path: string, before: string, after: string) => Promise<void>) {
  const resolution = resolve("node_modules/eve/dist/src/harness/hitl/pending-input-resolution.js");
  // A reply's metadata belongs before the restored approval transcript. AI SDK executes approved
  // calls only when tool-approval-response is at the tail; a new unrelated message still defers.
  await replace(resolution,
    "function finishResolvedInput(t){let n={};",
    "function finishResolvedInput(t){let osinaraConsumedContext=t.resolvedStepInput?.message===void 0&&(t.resolvedStepInput?.context?.length??0)>0;if(osinaraConsumedContext)t.messages.splice(t.session.history.length,0,...t.resolvedStepInput.context.map(content=>({role:`user`,content})));let n={};");
  await replace(resolution,
    "t.deferTurnInput&&((t.resolvedStepInput?.context?.length??0)>0",
    "t.deferTurnInput&&t.resolvedStepInput?.message!==void 0&&((t.resolvedStepInput?.context?.length??0)>0");
  // Both result branches must tell the harness not to append the same context a second time.
  await replace(resolution,
    "Object.keys(n).length>0?{consumedMessage:",
    "Object.keys(n).length>0?{osinaraConsumedContext,consumedMessage:");
  await replace(resolution,
    "session:queueDeferredStepInput(t.session,n)}:{consumedMessage:",
    "session:queueDeferredStepInput(t.session,n)}:{osinaraConsumedContext,consumedMessage:");
  await replace(resolve("node_modules/eve/dist/src/harness/tool-loop.js"),
    "if(I?.context!==void 0&&B.deferredContext!==!0)",
    "if(I?.context!==void 0&&B.deferredContext!==!0&&B.osinaraConsumedContext!==!0)");
}
