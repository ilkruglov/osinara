/**
 * Eve turn-context patch tests.
 *
 * Delivery `context` is authored for one turn. Eve 0.40.0 kept those user messages in the
 * session history, so every later turn carried every earlier turn's memory and timeline blocks.
 * The patch stamps each context message with its turn id and drops other turns' stamped messages
 * from the prompt before the model call.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { codeShape, codeText } from "./vendored-code.js";

describe("Eve turn context patch", () => {
  it("stamps delivery context with the turn id and filters other turns' context from the prompt", async () => {
    const toolLoop = await readFile("vendor/eve/dist/src/harness/tool-loop.js", "utf8");

    const text = codeText(toolLoop);
    const stamp = text.indexOf(codeText(
      "for (let e of I.context) H.push({ content: e, role: `user`, providerOptions: { osinara: { turnContext: O.turnId } }, }",
    ));
    const filter = text.indexOf(codeText(
      ".filter( (e) => e.role !== `user` || e.providerOptions?.osinara?.turnContext === void 0 || e.providerOptions.osinara.turnContext === O.turnId",
    ));
    // The prompt is filtered before this turn's context is appended, so the current turn keeps
    // its own blocks on every model step while earlier turns' blocks never reach the model again.
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(filter);
    expect(codeShape(toolLoop)).not.toContain(codeShape("for(let e of I.context)H.push({content:e,role:`user`});"));
  });
  // A text check cannot tell what the expression keeps; running the vendored predicate can.
  it("keeps every non-user message, unstamped user context and this turn's own context", async () => {
    const toolLoop = await readFile("vendor/eve/dist/src/harness/tool-loop.js", "utf8");
    const predicate = /\(e\) =>\s*e\.role !== `user` \|\|[^,]*?=== O\.turnId/u.exec(toolLoop)?.[0];
    if (!predicate) throw new Error("TEST_EVE_TURN_CONTEXT_FILTER_MISSING");
    // oxlint-disable-next-line typescript/no-implied-eval -- the vendored predicate is evaluated to test it
    const keep = new Function("O", `return ${predicate};`)({ turnId: "turn-2" }) as (message: unknown) => boolean;
    const stamped = (turnContext: string) => ({ content: "c", providerOptions: { osinara: { turnContext } }, role: "user" });

    expect(keep({ content: "a", role: "assistant" })).toBe(true);
    expect(keep({ content: "a", providerOptions: { osinara: { turnContext: "turn-1" } }, role: "assistant" })).toBe(true);
    expect(keep({ content: "u", role: "user" })).toBe(true);
    expect(keep(stamped("turn-2"))).toBe(true);
    expect(keep(stamped("turn-1"))).toBe(false);
  });
});
