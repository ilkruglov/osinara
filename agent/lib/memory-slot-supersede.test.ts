/**
 * Slot conflicts and capacity.
 *
 * Constructs covered:
 * - A write that ignores an occupied slot is refused with the slot's records quoted, so the retry
 *   needs no list_memories step; a stale previousMemoryRefs set gets the same records.
 * - An addition names any part of the slot it read, since it retires nothing; a replace names it
 *   whole, since it retires every record; a ref that is no longer active refuses either.
 * - Long records are cut and a long slot is counted rather than quoted in full.
 * - A bounded multi-value slot must always remain readable and replaceable through the tool.
 */
import { describe, expect, it } from "vitest";
import { requireSlotUpdate } from "./memory-slot-supersede.js";
import { ModelFacingError } from "./model-facing-error.js";

function correctionOf(write: () => unknown): { code: string; correction: string } {
  try {
    write();
  } catch (error) {
    if (error instanceof ModelFacingError) return error.contract;
    throw error;
  }
  throw new Error("expected a slot conflict");
}

const ref = (i: number) => `mem_${i.toString(16).padStart(32, "0")}`;
const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), memory_ref: ref(i), content: `факт ${i}` }));

describe("slot conflicts", () => {
  const slot = rows.slice(0, 2);
  it("quotes the slot's records when the write ignores the slot", () => {
    const contract = correctionOf(() => requireSlotUpdate(slot, undefined));
    expect(contract.code).toBe("AGENT_MEMORY_SLOT_REVIEW_REQUIRED");
    expect(contract.correction).toContain(`${ref(0)}: "факт 0"; ${ref(1)}: "факт 1"`);
    expect(contract.correction).not.toContain("list_memories");
  });
  it("quotes the records when a replace names only part of the slot", () => {
    const contract = correctionOf(() => requireSlotUpdate(slot, { action: "replace", previousMemoryRefs: [ref(0)] }));
    expect(contract.code).toBe("AGENT_MEMORY_SLOT_CHANGED");
    expect(contract.correction).toContain(`${ref(1)}: "факт 1"`);
  });
  it("accepts an addition that names only part of the slot", () => {
    // 38 of 42 SLOT_CHANGED refusals on production (3–6 October 2026) were additions naming a
    // subset: nothing is retired by an add, so the subset proves the read as well as the whole.
    expect(requireSlotUpdate(slot, { action: "add", previousMemoryRefs: [ref(0)] })).toEqual([]);
  });
  it("refuses a reference that is no longer in the slot, for add and replace alike", () => {
    for (const action of ["add", "replace"] as const) {
      const contract = correctionOf(() => requireSlotUpdate(slot, { action, previousMemoryRefs: [ref(0), ref(7)] }));
      expect(contract.code).toBe("AGENT_MEMORY_SLOT_CHANGED");
    }
    expect(correctionOf(() => requireSlotUpdate(slot, { action: "add", previousMemoryRefs: [] })).code).toBe("AGENT_MEMORY_SLOT_CHANGED");
  });
  it("cuts long records and counts the rest of a long slot", () => {
    const long = [{ id: "x", memory_ref: ref(99), content: "д".repeat(300) }, ...rows.slice(0, 25)];
    const { correction } = correctionOf(() => requireSlotUpdate(long, undefined));
    expect(correction).toContain(`${ref(99)}: "${"д".repeat(200)}…"`);
    expect(correction).toContain(`ещё 6: ${ref(19)}, ${ref(20)}, ${ref(21)}, ${ref(22)}, ${ref(23)}, ${ref(24)}`);
    // The cut record and the unquoted ones are named for a full read before any replace.
    expect(correction).toContain(`Перед replace прочитай полный текст через list_memories: ${ref(99)}, ${ref(19)}`);
    expect(correction).not.toContain(`${ref(24)}: `);
  });
  it("accepts a write that names the whole slot", () => {
    expect(requireSlotUpdate(slot, { action: "add", previousMemoryRefs: [ref(1), ref(0)] })).toEqual([]);
    expect(requireSlotUpdate(slot, { action: "replace", previousMemoryRefs: [ref(0), ref(1)] })).toEqual(["0", "1"]);
  });
});

describe("slot update capacity", () => {
  it("refuses an addition that would make the next snapshot exceed the tool limit", () => {
    expect(() => requireSlotUpdate(rows, { action: "add", previousMemoryRefs: rows.map((row) => row.memory_ref) }))
      .toThrow("AGENT_MEMORY_SLOT_LIMIT_REACHED");
  });
  it("still permits consolidation of the full slot", () => {
    expect(requireSlotUpdate(rows, { action: "replace", previousMemoryRefs: rows.map((row) => row.memory_ref) }))
      .toEqual(rows.map((row) => row.id));
  });
});
