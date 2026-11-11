/**
 * The zip reader against hostile archives.
 *
 * Constructs covered:
 * - The total of selected entries and their number are capped, not only each entry.
 * - A stored entry is held to the limit by its real length, not its declared size.
 * - A truncated AES extra field is a corrupt archive, not a crash.
 *
 * The archives are built byte by byte (`buildZip`), so each lie is exactly the one under test.
 */
import { describe, expect, it } from "vitest";

import { readZipEntries, ZipArchiveError } from "./zip-archive.js";
import { buildZip } from "./zip-test-builder.js";

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ZipArchiveError ? error.reason : String(error);
  }
  return "no error";
}

const LIMITS = { maxEntries: 3, maxEntryBytes: 1024, maxTotalBytes: 2048, password: null };
const all = () => true;

describe("readZipEntries", () => {
  it("reads stored entries within the limits", () => {
    const zip = buildZip([{ data: Buffer.from("date\n"), name: "ACTIVITY/ACTIVITY_1.csv" }]);
    expect(readZipEntries(zip, all, LIMITS).get("ACTIVITY/ACTIVITY_1.csv")?.toString()).toBe(
      "date\n",
    );
  });

  it("caps the total and the number of selected entries", () => {
    const thirds = Array.from({ length: 3 }, (_, index) => ({
      data: Buffer.alloc(900, 65),
      name: `ACTIVITY/ACTIVITY_${index}.csv`,
    }));
    expect(reason(() => readZipEntries(buildZip(thirds), all, LIMITS))).toBe("too_large");
    const many = Array.from({ length: 4 }, (_, index) => ({
      data: Buffer.from("x"),
      name: `ACTIVITY/ACTIVITY_${index}.csv`,
    }));
    expect(reason(() => readZipEntries(buildZip(many), all, LIMITS))).toBe("too_large");
  });

  it("counts every selected entry, repeated names too", () => {
    const repeated = Array.from({ length: 4 }, () => ({ data: Buffer.from("x"), name: "a.csv" }));
    expect(reason(() => readZipEntries(buildZip(repeated), all, LIMITS))).toBe("too_large");
  });

  it("holds a stored entry to its real length", () => {
    const lying = buildZip([{ data: Buffer.alloc(4096, 65), declaredSize: 10, name: "a.csv" }]);
    expect(reason(() => readZipEntries(lying, all, LIMITS))).toBe("too_large");
  });

  it("calls a truncated AES extra field corrupt", () => {
    const extra = Buffer.alloc(6);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(7, 2);
    const zip = buildZip([{ data: Buffer.alloc(40), extra, flags: 1, method: 99, name: "a.csv" }]);
    expect(reason(() => readZipEntries(zip, all, { ...LIMITS, password: "x" }))).toBe("corrupt");
  });
});
