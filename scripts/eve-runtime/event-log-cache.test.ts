/**
 * Workflow event log cache tests.
 *
 * Constructs covered:
 * - Only a payload-free ascending full listing is cacheable.
 * - A stored log is returned with its cursor and survives until it is dropped.
 * - The least recently read run is evicted once the bound is reached.
 * - Every resume reports how much of the log it reused.
 */
import { describe, expect, it } from "vitest";

import {
  dropEventLogCache,
  eventLogCacheKey,
  readEventLogCache,
  traceEventLogRead,
  writeEventLogCache,
} from "./event-log-cache.ts";

const RUN = "wrun_01M240G2QGE9TDC7NSVNY6VZAY";

describe("eventLogCacheKey", () => {
  it("accepts the resume listing", () => {
    expect(eventLogCacheKey({ runId: RUN }, "none", "asc")).toBe(RUN);
    expect(eventLogCacheKey({ pagination: {}, runId: RUN }, "none", "asc")).toBe(RUN);
  });

  it.each([
    ["payloads requested", { runId: RUN }, "all", "asc"],
    ["reverse order", { runId: RUN }, "none", "desc"],
    ["explicit page", { pagination: { limit: 100 }, runId: RUN }, "none", "asc"],
    ["caller cursor", { pagination: { cursor: "evnt_1" }, runId: RUN }, "none", "asc"],
    ["no run", { runId: "" }, "none", "asc"],
  ])("refuses %s", (_name, params, resolveData, sortOrder) => {
    expect(eventLogCacheKey(params, resolveData, sortOrder)).toBeNull();
  });
});

describe("event log cache", () => {
  it("returns the stored log and its cursor, and forgets it when dropped", () => {
    writeEventLogCache(RUN, [{ eventId: "evnt_1" }, { eventId: "evnt_2" }], "evnt_2");

    expect(readEventLogCache(RUN)).toEqual({
      cursor: "evnt_2",
      data: [{ eventId: "evnt_1" }, { eventId: "evnt_2" }],
    });

    dropEventLogCache(RUN);
    expect(readEventLogCache(RUN)).toBeUndefined();
  });

  it("copies the stored log so a later caller cannot mutate it", () => {
    const events = [{ eventId: "evnt_1" }];
    writeEventLogCache(RUN, events, "evnt_1");
    events.push({ eventId: "evnt_2" });

    expect(readEventLogCache(RUN)?.data).toHaveLength(1);
    dropEventLogCache(RUN);
  });

  it("evicts the least recently read run past the bound", () => {
    for (let index = 0; index < 25; index += 1) {
      writeEventLogCache(`run-${index}`, [{ eventId: `evnt_${index}` }], `evnt_${index}`);
    }

    expect(readEventLogCache("run-0")).toBeUndefined();
    expect(readEventLogCache("run-24")).toBeDefined();

    // Reading run-1 makes it recent, so the next write evicts run-2 instead.
    expect(readEventLogCache("run-1")).toBeDefined();
    writeEventLogCache("run-25", [{ eventId: "evnt_25" }], "evnt_25");

    expect(readEventLogCache("run-1")).toBeDefined();
    expect(readEventLogCache("run-2")).toBeUndefined();
    for (let index = 0; index <= 25; index += 1) dropEventLogCache(`run-${index}`);
  });
});

describe("traceEventLogRead", () => {
  it("reports reuse, tail size and duration for one resume", () => {
    const lines: string[] = [];

    traceEventLogRead(RUN, 585, 13, 4.6, (line) => lines.push(line));

    expect(JSON.parse(lines[0]!)).toEqual({
      code: "AGENT_WORKFLOW_EVENT_LOG",
      fetched: 13,
      ms: 5,
      reused: 585,
      runId: RUN,
    });
  });
});
