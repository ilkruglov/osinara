/**
 * Input pieces shared by the health journal's tools.
 *
 * Constructs covered:
 * - `civilDate` refuses a malformed or nonexistent date as a validation issue, never an exception.
 */
import { describe, expect, it } from "vitest";

import { civilDate } from "./health-access.js";

describe("civilDate", () => {
  it("validates instead of throwing", () => {
    const check = (value: string) => civilDate().safeParse(value).success;
    expect(["2026-11-11", "2028-02-29"].map(check)).toEqual([true, true]);
    expect(["2026-02-31", "2026-99-01", "junk", ""].map(check)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
