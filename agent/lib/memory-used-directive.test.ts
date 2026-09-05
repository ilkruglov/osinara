/**
 * `<memory-used>` directive tests.
 *
 * Constructs covered:
 * - A trailing directive is removed and its valid refs returned once each.
 * - A directive between words leaves readable text; malformed refs are ignored.
 * - Text without a directive is untouched.
 */
import { describe, expect, it } from "vitest";

import { extractMemoryUsedDirective } from "./memory-used-directive.js";

const A = "mem_0123456789abcdef0123456789abcdef";
const B = "mem_fedcba9876543210fedcba9876543210";

describe("extractMemoryUsedDirective", () => {
  it("strips the trailing directive and returns unique valid refs", () => {
    expect(extractMemoryUsedDirective(`Гоша живёт дома.\n<memory-used>${A}, ${A},${B}</memory-used>`))
      .toEqual({ memoryRefs: [A, B], message: "Гоша живёт дома." });
  });

  it("drops a directive placed mid-text and ignores malformed refs", () => {
    expect(extractMemoryUsedDirective("Да.<memory-used>x, mem_short</memory-used> Точно."))
      .toEqual({ memoryRefs: [], message: "Да. Точно." });
  });

  it("leaves text without a directive untouched", () => {
    expect(extractMemoryUsedDirective("Просто ответ")).toEqual({ memoryRefs: [], message: "Просто ответ" });
  });
});
