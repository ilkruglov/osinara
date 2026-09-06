/** Internal, backend-authored skill packages. Never a model-facing file-write contract. */
import { z } from "zod";

const name = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u);
const path = z.string().min(1).max(4096).refine((value) => !value.includes("\\") && !value.includes("\0") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const schema = z.strictObject({
  expectedInstanceId: z.string().regex(/^[a-f0-9]{64}$/u),
  packages: z.array(z.strictObject({ name, files: z.array(z.strictObject({ path, contentBase64: z.base64() })).min(1).max(512) })).max(128),
  removed: z.array(name).max(128),
}).superRefine((request, ctx) => {
  const names = request.packages.map((pkg) => pkg.name);
  if (new Set(names).size !== names.length || new Set(request.removed).size !== request.removed.length || request.removed.some((item) => names.includes(item))) {
    ctx.addIssue({ code: "custom", message: "Conflicting skill names" });
  }
  for (const pkg of request.packages) {
    const paths = pkg.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length || !paths.includes("SKILL.md")) ctx.addIssue({ code: "custom", message: "Invalid skill file manifest" });
  }
});
export type SkillSyncRequest = z.infer<typeof schema>;
export interface SkillSyncResult { checked: number; written: number; removed: number }
export interface MaterializedSkillPackage { name: string; files: ReadonlyArray<{ relativePath: string; content: Uint8Array }> }
export function parseSkillSyncRequest(value: unknown): SkillSyncRequest {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_INVALID: Invalid skill synchronization manifest");
  return parsed.data;
}
