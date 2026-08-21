/**
 * Direct-provider image generation denial tests.
 *
 * Constructs covered:
 * - A persisted group grant cannot advertise or execute subscription generation without CLIProxy.
 * - Trusted modes omit the tool rather than exposing a guaranteed configuration failure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: false,
}));

import { externalGroupCapabilityInstructions } from "../tool-policy/external-group-capability-instructions.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";

describe("unavailable subscription image generation", () => {
  it("omits tool, skill loading, and prompt guidance", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      skills: { imagegen: {} as never },
    });
    const instructions = externalGroupCapabilityInstructions(
      new Set(["generate_image"]),
      new Set(),
    );

    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("generate_image");
    expect(external).not.toHaveProperty("generate_image");
    expect(external.load_skill?.description).toMatch(/недоступен/iu);
    expect(instructions).not.toContain("generate_image");
    expect(instructions).not.toContain("skill=imagegen");
  });
});
