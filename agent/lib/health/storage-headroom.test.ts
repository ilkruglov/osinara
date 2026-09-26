/**
 * Storage headroom tests.
 *
 * Constructs covered:
 * - Quiet when there is room; a line when free space is under a fifth or an update would fail
 *   the installer's space check (both databases × 2 + reserve).
 * - An unreadable filesystem or database size does not throw.
 */
import { describe, expect, it, vi } from "vitest";

import { formatStorageHeadroom, readStorageHeadroom, updateRequirementBytes } from "./storage-headroom.js";

const G = 1024 ** 3;

describe("formatStorageHeadroom", () => {
  it("is silent with room and speaks when an update would not fit", () => {
    expect(formatStorageHeadroom({ databaseBytes: 3 * G, freeBytes: 20 * G, totalBytes: 40 * G })).toBeNull();
    // 25 сентября 2026: 6,9 GiB free, 3,3 GiB of databases, the update failed its preflight.
    const line = formatStorageHeadroom({ databaseBytes: 3.3 * G, freeBytes: 6.9 * G, totalBytes: 40 * G });
    expect(line).toContain("Диск: свободно 6,9 ГиБ из 40,0 ГиБ (17 %), базы 3,3 ГиБ.");
    expect(line).toContain("нужно не меньше 7,1 ГиБ");
    expect(updateRequirementBytes(3.3 * G)).toBe(3.3 * G * 2 + 512 * 1024 ** 2);
    expect(formatStorageHeadroom({ databaseBytes: null, freeBytes: 5 * G, totalBytes: 40 * G })).toContain("Места мало");
    expect(formatStorageHeadroom({ databaseBytes: null, freeBytes: null, totalBytes: null })).toBeNull();
  });
});

describe("readStorageHeadroom", () => {
  it("reads the root filesystem and survives a failing database size", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const headroom = await readStorageHeadroom(async () => { throw new Error("no database"); });
    expect(headroom.totalBytes).toBeGreaterThan(0);
    expect(headroom.databaseBytes).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_DATABASE_SIZE_UNREADABLE"));
    error.mockRestore();
  });
});
