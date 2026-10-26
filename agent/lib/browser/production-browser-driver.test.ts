/**
 * The production browser driver and a background check's hold.
 *
 * Constructs covered:
 * - Every command of a turn first marks the browser as the turn's (waiting for a background hold).
 * - A background check drives the browser only while its hold is still its own, and stops at once
 *   when the hold ran out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [] as string[], enter: vi.fn(), holds: vi.fn() }));

vi.mock("./browser-hold.js", () => ({ browserHoldRepository: { enterAsTurn: mocks.enter, holdsStill: mocks.holds } }));
vi.mock("./browser-driver.js", () => ({
  createSandboxBrowserDriver: () => Object.fromEntries(
    ["back", "eval", "open", "press", "screenshot", "scroll", "settle", "url"].map((name) => [name, async () => { mocks.calls.push(name); return name === "eval" || name === "url" ? "ok" : undefined; }]),
  ),
}));

import { productionBrowserDriver } from "./production-browser-driver.js";

describe("productionBrowserDriver", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.enter.mockReset().mockImplementation(async () => { mocks.calls.push("enter"); });
    mocks.holds.mockReset().mockImplementation(async () => { mocks.calls.push("holds"); return true; });
  });

  it("marks the browser as the turn's before every command of a turn", async () => {
    const driver = productionBrowserDriver({ sandboxSessionId: "thread-1" });
    await driver.open("https://taxi.yandex.ru/robots.txt");
    await expect(driver.eval("1")).resolves.toBe("ok");
    await driver.settle();
    expect(mocks.calls).toEqual(["enter", "open", "enter", "eval", "enter", "settle"]);
    expect(mocks.enter).toHaveBeenCalledWith("thread-1", undefined);
    expect(mocks.holds).not.toHaveBeenCalled();
  });

  it("lets a background check drive the browser only while its hold is its own", async () => {
    const driver = productionBrowserDriver({ background: { holder: "hold-1" }, sandboxSessionId: "thread-1" });
    await driver.url();
    expect(mocks.calls).toEqual(["holds", "url"]);
    expect(mocks.holds).toHaveBeenCalledWith({ holder: "hold-1", sandboxSessionId: "thread-1" });
    mocks.holds.mockResolvedValueOnce(false);
    await expect(driver.open("https://lavka.yandex.ru/")).rejects.toMatchObject({ code: "AGENT_BROWSER_HOLD_LOST" });
    expect(mocks.calls).not.toContain("open");
    expect(mocks.enter).not.toHaveBeenCalled();
  });
});
