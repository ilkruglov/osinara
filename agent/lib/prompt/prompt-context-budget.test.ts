/** Deterministic authored-context budget guarding model prefill latency. */
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

// The worst case must count every purpose line, the avatars' included: it exists only with a
// configured image provider.
vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { manageMemoryPresentation } from "../tools/manage_memory.js";
import { EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/group-tool-catalog.js";
import { modeInstructions } from "./mode-instructions.js";

// The mode block is re-sent on every model step: rules that only matter when a specific tool is
// called belong in that tool's descriptor or skill, not here.
// Raised by 300 on 5 September 2026 for the owner's rule on mild, self-invented swearing.
// Raised by 400 on 9 September 2026: style records are a hint, not a promise; namesakes by username.
// Raised by 400 on 10 September 2026: mirroring is how the no-swearing rule leaked. 34 of 1 708 of
// her group messages carried obscene roots, some quoting the other person, some her own voice.
const CORE_CHARACTER_BUDGET = 12_400;
// Raised by 200 on 8 September 2026 for the mandatory used-memory directive wording, including
// the "after the answer, not instead of it" clause added after the directive-only eval case.
// Raised by 400 on 10 September 2026: a chat rule is born only by an explicit durable request.
// Raised by 400 on 13 September 2026 for recurrence periods from a minute to a year (upstream v0.22.0).
// Raised by 400 on 22 September 2026: browser_task routing; by 400 on 25 September for the browser
// tools section that replaced it (open, look, act, confirm, the worker, save_field).
// +1 500 on 26 September 2026: the rules for messages that arrive while a turn works.
// +600 on 5 October 2026: the reply-target rule with the selected quote (`replyQuotedText`), which
// private chats never had while the quote reached the model in groups only.
// +200 on 16 October 2026: the absolute swearing ban moved from the core into the trusted zones.
const PRIVATE_CHARACTER_BUDGET = 16_300;
// Raised by 400 on 5 September 2026 for the memory selection criterion and slot guidance, then by
// 300 on 6 September for the addressing section with the explicit silence directive, then by
// 300 the same day for the pending-messages rule in that section, then by 200 on 7 September for
// the rule not to re-answer a question the agent already closed, then by 200 on 8 September for
// the group length ceiling, then by 100 for the mandatory used-memory directive wording.
// Raised by 400 on 9 September 2026 for the joke target rotation sentence.
// Raised by 400 on 10 September 2026 for the same chat-rule sentence.
// Raised by 400 on 13 September 2026 for the same recurrence sentence.
// Raised by 400 on 22 September 2026 for the same browser_task sentence.
// Raised by 200 on 5 October 2026: the selected quote is explained outside the snapshot.
// +200 on 16 October 2026: the absolute swearing ban moved from the core into the trusted zones.
const FAMILY_CHARACTER_BUDGET = 18_400;
// Raised by 400 on 6 September 2026 for the addressing section with the explicit silence directive,
// then by 2 200 on 7 September for the participants section ported from upstream v0.21.2: opinions
// about behaviour on request, comparisons by a stated criterion, no diagnoses, no template refusal,
// then by 200 the same day for the rule not to re-answer a closed question, then by 200 on
// 8 September for the group length ceiling and by 100 for the mandatory used-memory directive.
// +1 000 on 16 October 2026: the character section, where one swear word answers a direct insult.
const EXTERNAL_CHARACTER_BUDGET = 15_100;
// Raised by 400 on 5 September 2026 for the memory policy: the used-memory directive and the
// selection criterion with the discussion-summary slot, then by 400 on 6 September for the
// addressing section with the explicit silence directive, then by 2 200 on 7 September for the
// participants section ported from upstream v0.21.2, then by 200 for the closed-question rule,
// then by 200 on 8 September for the group length ceiling and by 100 for the mandatory directive.
// Raised by 400 on 10 September 2026 for the same chat-rule sentence.
// +1 100 on 16 October 2026 for the external character section (about a thousand characters after
// the blind eval and the review: the source of the insult and the humiliation clause spelled out),
// +100 the same day for the avatar purpose line, +500 once the worst case counts the grant lines
// of generate_image and fetch_telegram_avatars (they exist only with a configured image provider,
// which this test never mocked before; measured 25 560 with the scheduled history section).
const EXTERNAL_WORST_CASE_CHARACTER_BUDGET = 25_600;
// Raised by 300 on 5 September 2026 for the two analyst skill lines in the external grant block,
// then by 600 the same day for the memory policy (used-memory directive, selection criterion),
// then by 300 for the owner's rule on mild, self-invented swearing in the core, then by 300 on
// 6 September for the addressing section with the explicit silence directive, then by 2 200 on
// 7 September for the participants section ported from upstream v0.21.2, then by 200 for the
// closed-question rule, then by 200 on 8 September for the group length ceiling and by 100 for
// the mandatory used-memory directive wording (200 in total: the worst case stacks two blocks),
// then by 400 on 10 September for the core rule against repeating another person's obscenity.
// +700 on 16 October 2026 for the external character section (the core itself grew by 31),
// +200 the same day for the image grant lines now counted in the external worst case (37 801).
const AUTHORED_TOTAL_CHARACTER_BUDGET = 37_900;

describe("authored prompt context budget", () => {
  it("keeps stable and mode-scoped instructions bounded", async () => {
    const core = await readFile("agent/instructions.md", "utf8");
    const privateMode = modeInstructions({ environment: "private" });
    const familyMode = modeInstructions({ environment: "family" });
    const externalMode = modeInstructions({
      capabilities: new Set(),
      environment: "external",
    });
    const allExternalCapabilities = new Set(EXTERNAL_GROUP_TOOL_NAMES);
    const externalWorstCases = [
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
      }),
      modeInstructions({
        capabilities: allExternalCapabilities,
        environment: "external",
        includeApplicationCore: true,
        scheduledHistory: true,
        scheduledRun: true,
      }),
    ];

    expect(core.length).toBeLessThanOrEqual(CORE_CHARACTER_BUDGET);
    expect(privateMode.length).toBeLessThanOrEqual(PRIVATE_CHARACTER_BUDGET);
    expect(familyMode.length).toBeLessThanOrEqual(FAMILY_CHARACTER_BUDGET);
    expect(externalMode.length).toBeLessThanOrEqual(EXTERNAL_CHARACTER_BUDGET);
    for (const mode of externalWorstCases) {
      expect(mode.length).toBeLessThanOrEqual(EXTERNAL_WORST_CASE_CHARACTER_BUDGET);
    }
    for (const mode of [privateMode, familyMode, externalMode, ...externalWorstCases]) {
      expect(core.length + mode.length).toBeLessThanOrEqual(AUTHORED_TOTAL_CHARACTER_BUDGET);
    }
  });

  it("does not ask ordinary memory edits to overwrite classification", () => {
    const { description } = manageMemoryPresentation(["edit"]);

    expect(description).toContain('"content":"Полная новая версия"');
    expect(description).not.toContain('"kind":"preference"');
    expect(description).not.toContain('"sensitivity":"normal"');
    expect(description).toContain("только при явном изменении классификации");
    // Mutation integrity guidance travels with the tool instead of every model step.
    expect(description).toContain("Сначала прочитай точную активную запись");
  });
});
