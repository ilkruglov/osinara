/**
 * Subscription image generation tool-surface tests.
 *
 * Constructs covered:
 * - Interactive roots receive image generation only when their runtime/provider policy permits it.
 * - Scheduled turns and subagents never receive the billable tool.
 * - External execution rechecks the live owner-managed capability before provider access.
 * - Participants' avatars exist only next to a live image grant: no descriptor without it, no
 *   scheduled or subagent access, and a revoked generate_image denies them at execution too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("./image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability,
  loadCurrentExternalGroupCapabilities,
}));

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "../tool-policy/mode-tool-surface.js";

function externalAuth(toolAllowlist: readonly string[] = ["generate_image"]) {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("image generation tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async () => {
      throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("exposes generation only to interactive roots", async () => {
    const deniedExternal = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("generate_image");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("generate_image");
    // A trusted scheduled turn (morning greeting card) may generate; an external one still may not.
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true }))
      .toHaveProperty("generate_image");
    expect(buildModeToolSurface({ environment: "family", scheduledRun: true }))
      .toHaveProperty("generate_image");
    expect(buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
    })).toHaveProperty("generate_image");
    expect(buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      scheduledRun: true,
    })).not.toHaveProperty("generate_image");
    expect(buildSubagentToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
    }).load_skill?.description).toMatch(/недоступен/iu);
    expect(deniedExternal).not.toHaveProperty("generate_image");
    // Without the image grant load_skill stays as the fail-closed wrapper for granted skills.
    expect(deniedExternal.load_skill?.description).not.toMatch(/недоступен/iu);
    await expect(deniedExternal.load_skill!.execute({ skill: "gws-gmail" }, {} as never))
      .rejects.toThrowError(/AGENT_GROUP_SKILL_FORBIDDEN/u);
  });

  it("denies an external call after live capability revocation", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
    });
    const context = { session: { auth: externalAuth() } } as never;

    await expect(surface.generate_image!.execute({}, context))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(surface.generate_image!.description).not.toMatch(/[—–«»]/u);
  });

  it("ties participants' avatars to a live image grant", async () => {
    const both = new Set<ExternalGroupToolName>(["generate_image", "fetch_telegram_avatars"]);
    const surface = buildModeToolSurface({ capabilities: both, environment: "external" });

    expect(surface).toHaveProperty("fetch_telegram_avatars");
    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("fetch_telegram_avatars");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("fetch_telegram_avatars");
    // Without a picture to draw the avatars have no purpose: no descriptor at all.
    expect(buildModeToolSurface({ capabilities: new Set(["fetch_telegram_avatars"]), environment: "external" }))
      .not.toHaveProperty("fetch_telegram_avatars");
    expect(buildModeToolSurface({ capabilities: both, environment: "external", scheduledRun: true }))
      .not.toHaveProperty("fetch_telegram_avatars");
    expect(buildSubagentToolSurface({ capabilities: both, environment: "external" }))
      .not.toHaveProperty("fetch_telegram_avatars");

    // The owner revoked only generate_image after the descriptor was resolved: the live policy
    // still grants the avatars, yet the download must not happen. Both grants are demanded from
    // the same read, so no interleaved change can satisfy them one at a time.
    authorizeCurrentExternalGroupCapability.mockImplementation(async (_identity: unknown, capability: unknown, options?: { alsoRequired?: readonly string[] }) => {
      const live = new Set(["fetch_telegram_avatars"]);
      if (capability !== "fetch_telegram_avatars" || !(options?.alsoRequired ?? []).every((name) => live.has(name))) {
        throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
      }
    });
    const context = { session: { auth: externalAuth([...both]) } } as never;
    await expect(surface.fetch_telegram_avatars!.execute({ participants: [{ telegramUserId: "5" }] }, context))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(authorizeCurrentExternalGroupCapability).toHaveBeenCalledTimes(1);
    expect(authorizeCurrentExternalGroupCapability).toHaveBeenCalledWith(
      expect.anything(), "fetch_telegram_avatars", { alsoRequired: ["generate_image"] },
    );
    expect(surface.fetch_telegram_avatars!.description).not.toMatch(/[—–«»]/u);
  });

  it("does not expose workspace scope as model input", () => {
    const tool = buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
    }).generate_image!;
    const schema = tool.inputSchema as z.ZodType;
    const input = {
      background: "auto",
      prompt: "A clean editorial illustration",
      quality: "auto",
      size: "auto",
    };

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, scope: "group" }).success).toBe(false);
  });
});
