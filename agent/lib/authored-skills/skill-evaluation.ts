/** Deterministic checks over observed tool results. These prove execution facts, not subjective quality. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const skillCheckSchema = z.object({
  toolName: z.string().min(1).max(100),
  path: z.array(z.string().max(100)).max(12).default([]),
  operator: z.enum(["equals", "nonempty", "succeeded"]),
  expected: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional(),
}).strict().refine((check) => check.operator !== "equals" || check.expected !== undefined, "equals requires expected");
export type SkillCheck = z.infer<typeof skillCheckSchema>;
export interface ObservedSkillResult { toolName: string; succeeded: boolean; output: unknown }

export function evaluateTrial(checks: readonly SkillCheck[], results: readonly ObservedSkillResult[]): boolean[] {
  return checks.map((check) => results.some((result) => {
    if (!result.succeeded || result.toolName !== check.toolName) return false;
    if (check.operator === "succeeded") return true;
    let value: unknown = result.output;
    for (const key of check.path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, unknown>)[key];
    }
    return check.operator === "equals" ? value === check.expected :
      typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0;
  }));
}

export function skillContentHash(content: { name: string; description: string; markdown: string; files: Readonly<Record<string, string>> }): string {
  return createHash("sha256").update(JSON.stringify([
    content.name, content.description, content.markdown,
    Object.entries(content.files).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
}
