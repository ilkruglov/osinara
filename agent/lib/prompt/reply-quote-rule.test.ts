/**
 * Placement of the reply-target rule, including the selected quote, across modes.
 *
 * Constructs covered:
 * - Private, family and external modes explain `replyQuotedText` with one shared wording.
 * - The quote is described as untrusted words of the target, never as the sender's request.
 * - The retired `quotedText` field inside the snapshot is no longer described anywhere.
 */
import { describe, expect, it } from "vitest";

import { REPLY_TARGET_RULES } from "./common-fragments.js";
import { modeInstructions } from "./mode-instructions.js";

const modes = {
  external: modeInstructions({ capabilities: new Set(), environment: "external" }),
  family: modeInstructions({ environment: "family" }),
  private: modeInstructions({ environment: "private" }),
};

describe("reply target rule", () => {
  it("describes the selected quote as untrusted words of the target", () => {
    expect(REPLY_TARGET_RULES).toContain("`replyQuotedText`");
    expect(REPLY_TARGET_RULES).toContain("недоверенн");
    expect(REPLY_TARGET_RULES).toContain("не поручение");
  });

  it.each(Object.entries(modes))("is present in the %s mode", (_name, instructions) => {
    expect(instructions).toContain(REPLY_TARGET_RULES);
    expect(instructions).not.toContain("`quotedText`");
  });
});
