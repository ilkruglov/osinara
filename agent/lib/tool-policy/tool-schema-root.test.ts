/**
 * Every model-facing tool must present an object at the root of its JSON schema.
 *
 * Constructs covered:
 * - Each module in `agent/lib/tools/` and each browser worker tool converts to a JSON schema whose
 *   root is `type: object`: DeepSeek rejects any other root with 400 «schema must be a JSON Schema
 *   of type object», which on 25 сентября 2026 took every private chat down for three hours
 *   (browser_task carried a `discriminatedUnion` at its root).
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const TOOL_DIRECTORY = "agent/lib/tools";

async function schemaRoots(): Promise<Array<{ name: string; root: unknown }>> {
  const roots: Array<{ name: string; root: unknown }> = [];
  for (const file of readdirSync(TOOL_DIRECTORY).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const module = await import(`../tools/${file}`) as { default?: { inputSchema?: z.ZodType } };
    const schema = module.default?.inputSchema;
    if (schema === undefined) continue;
    const json = z.toJSONSchema(schema, { io: "input", target: "draft-7" }) as { type?: unknown };
    roots.push({ name: file.replace(/\.ts$/u, ""), root: json.type });
  }
  return roots;
}

describe("tool input schemas", () => {
  it("put an object at the root of every model-facing tool", async () => {
    const roots = await schemaRoots();
    expect(roots.length).toBeGreaterThan(30);
    const offenders = roots.filter((r) => r.root !== "object").map((r) => r.name);
    expect(offenders).toEqual([]);
  }, 30_000); // imports every tool module; 1.8 s alone, past 5 s under the parallel run

  it("would catch a discriminated union at the root", () => {
    const union = z.discriminatedUnion("action", [z.object({ action: z.literal("a") }), z.object({ action: z.literal("b") })]);
    expect((z.toJSONSchema(union, { io: "input", target: "draft-7" }) as { type?: unknown }).type).not.toBe("object");
  });
});
