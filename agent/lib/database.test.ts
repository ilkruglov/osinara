/**
 * Session options of the application pool.
 *
 * Constructs covered:
 * - Every connection starts with pgvector's iterative scan and a wide scan budget.
 * - An `options` parameter of the connection string would override the config's in node-pg, so
 *   it is moved out of the string and kept in front of the settings.
 */
import { describe, expect, it } from "vitest";

import { poolConnection } from "./database.js";

describe("poolConnection", () => {
  it("sets the pgvector scan settings", () => {
    expect(poolConnection("postgresql://u:p@h:5432/db")).toEqual({
      connectionString: "postgresql://u:p@h:5432/db",
      options: "-c hnsw.iterative_scan=relaxed_order -c hnsw.max_scan_tuples=200000",
    });
  });

  it("moves options out of the connection string and keeps them in front of the settings", () => {
    expect(poolConnection("postgresql://u:p@h:5432/db?options=-c%20search_path%3Dpublic&application_name=x")).toEqual({
      connectionString: "postgresql://u:p@h:5432/db?application_name=x",
      options: "-c search_path=public -c hnsw.iterative_scan=relaxed_order -c hnsw.max_scan_tuples=200000",
    });
  });
});
