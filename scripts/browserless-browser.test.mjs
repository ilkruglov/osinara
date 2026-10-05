import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { browserEnvironment, cloudEndpoint } from "../agent/skills/agent-browser/scripts/browserless.mjs";

const HELPER = "agent/skills/agent-browser/scripts/browserless.mjs";

describe("Browserless fallback", () => {
  it("reports an unavailable cloud browser without starting a session", async () => {
    const env = { ...process.env };
    delete env.BROWSERLESS_AVAILABLE;
    await expect(promisify(execFile)(process.execPath, [HELPER, "open", "https://example.com"], { env }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AGENT_BROWSERLESS_NOT_CONFIGURED") });
  });

  // 2 October 2026: the cloud helper accepted click and fill, so a public form could be sent with
  // the person's phone past the confirmation gate of browser_act.
  it("reads pages but refuses every page action", async () => {
    const env = { ...process.env };
    delete env.BROWSERLESS_API_KEY;
    for (const command of ["click", "fill", "type", "press", "select", "check", "uncheck", "hover"]) {
      await expect(promisify(execFile)(process.execPath, [HELPER, command, "@e1"], { env }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AGENT_BROWSERLESS_COMMAND_FORBIDDEN") });
    }
  });

  it("asks for a new open instead of starting another cloud browser after the session ended", async () => {
    const env = { ...process.env, BROWSERLESS_AVAILABLE: "true", HTTPS_PROXY: "http://sandbox-egress-proxy:3128" };
    await expect(promisify(execFile)(process.execPath, [HELPER, "snapshot", "-i"], { env }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AGENT_BROWSERLESS_SESSION_EXPIRED") });
  });

  // The key stays in the egress proxy (security review, 5 October 2026): agent-browser connects to
  // the proxy's endpoint with autosolve and the free-plan deadline, and no token.
  it("connects to the proxy's endpoint only, without a key, and refuses a proxy URL with credentials", () => {
    const endpoint = new URL(cloudEndpoint("http://sandbox-egress-proxy:3128"));
    expect(endpoint.protocol).toBe("ws:");
    expect(endpoint.host).toBe("sandbox-egress-proxy:3128");
    expect(endpoint.pathname).toBe("/browserless/chromium/stealth");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({ solveCaptchas: "true", timeout: "120000" });
    for (const proxy of ["http://user:pass@sandbox-egress-proxy:3128", "https://sandbox-egress-proxy:3128", "http://sandbox-egress-proxy:3128/x", undefined]) {
      expect(() => cloudEndpoint(proxy)).toThrow("AGENT_BROWSERLESS_PROXY_INVALID");
    }
  });

  it("isolates cloud state from local restore, profiles, proxy and credentials", () => {
    const env = browserEnvironment({
      HOME: "/tools/personal/home", PATH: "/usr/bin", BROWSERLESS_API_KEY: "secret",
      AGENT_BROWSER_RESTORE: "osinara", AGENT_BROWSER_PROFILE: "/private-profile",
      AGENT_BROWSER_PROXY: "http://sandbox-egress-proxy:3128", AGENT_BROWSER_PROVIDER: "other",
    });
    expect(env.HOME).toBe("/tmp/osinara-browserless-home");
    expect(env.AGENT_BROWSER_SESSION).toBe("osinara-cloud");
    expect(env.PATH).toBe("/usr/bin");
    for (const key of ["BROWSERLESS_API_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_PROFILE", "AGENT_BROWSER_PROXY", "AGENT_BROWSER_PROVIDER"]) {
      expect(env[key]).toBeUndefined();
    }
  });
});
