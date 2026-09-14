/** A bounded multi-value slot must always remain readable and replaceable through the tool. */
import { describe, expect, it } from "vitest";
import { requireSlotUpdate } from "./memory-slot-supersede.js";

describe("slot update capacity", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), memory_ref: `mem_${i.toString(16).padStart(32, "0")}` }));
  it("refuses an addition that would make the next snapshot exceed the tool limit", () => {
    expect(() => requireSlotUpdate(rows, { action: "add", previousMemoryRefs: rows.map((row) => row.memory_ref) }))
      .toThrow("AGENT_MEMORY_SLOT_LIMIT_REACHED");
  });
  it("still permits consolidation of the full slot", () => {
    expect(requireSlotUpdate(rows, { action: "replace", previousMemoryRefs: rows.map((row) => row.memory_ref) }))
      .toEqual(rows.map((row) => row.id));
  });
});
