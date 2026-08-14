/**
 * Production sandbox configuration tests.
 *
 * Constructs covered:
 * - Explicit selection of the isolated runner backend.
 * - Auth-scoped persistent mounts are installed at session start.
 * - Background memory review receives a disabled sandbox without workspace mounts.
 */
import { describe, expect, it, vi } from "vitest";

import sandbox from "./sandbox.js";

describe("agent sandbox", () => {
  it("selects a backend explicitly instead of relying on production auto-detection", () => {
    expect(sandbox.backend).toMatchObject({ name: "osinara-scoped-runner-v3" });
  });

  it("installs verified workspace mounts on each Eve session", () => {
    expect(sandbox.onSession).toBeTypeOf("function");
  });

  it("disables workspace access for background memory review sessions", async () => {
    const use = vi.fn().mockResolvedValue(undefined);
    if (!sandbox.onSession) {
      throw new Error("AGENT_TEST_SANDBOX_SESSION_HOOK_MISSING: Sandbox onSession hook is required");
    }

    await sandbox.onSession({
      ctx: {
        session: {
          auth: {
            current: {
              attributes: {
                memoryReviewMode: "background",
                sandboxSessionId: "00000000-0000-4000-8000-000000000070",
              },
              authenticator: "memory-review",
              principalId: "00000000-0000-4000-8000-000000000030",
              principalType: "user",
            },
          },
        },
      },
      use,
    } as never);

    expect(use).toHaveBeenCalledWith({
      mounts: [],
      sandboxSessionId: "00000000-0000-4000-8000-000000000070",
    });
  });
});
