/** Frozen checks for authored skills. Scenario evidence never claims real external execution. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";

export const experimentPath = z.string().max(180).regex(/^\/workspace\/[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/u);
export const artifactCheckSchema = z.object({
  path: experimentPath,
  text: z.string().max(8000).optional(),
  json: z.json().optional(),
}).strict().refine((c) => (c.text === undefined) !== (c.json === undefined), "Exactly one expected artifact is required");
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u);
const toolInput = z.record(z.string(), z.json());
export const toolFixtureSchema = z.object({
  toolName, input: toolInput, output: z.json(), isError: z.boolean().optional(),
  files: z.record(experimentPath, z.string().max(8000)).optional(),
}).strict();
export const experimentCheckSchema = z.union([
  artifactCheckSchema,
  z.object({ target: z.literal("answer"), text: z.string().max(8000).optional(), json: z.json().optional() }).strict()
    .refine((c) => (c.text === undefined) !== (c.json === undefined), "Exactly one expected answer is required"),
  z.object({ target: z.literal("tool"), toolName, input: toolInput.optional(), count: z.number().int().min(0).max(32) }).strict(),
  z.object({ target: z.literal("rubric"), criteria: z.array(z.string().min(1).max(500)).min(1).max(5), reference: z.string().min(1).max(8000) }).strict(),
]);
export const experimentProtocolSchema = z.object({
  environment: z.enum(["files", "scenario"]).optional(),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/u),
    partition: z.enum(["development", "holdout"]),
    request: z.string().min(1).max(2000),
    files: z.record(experimentPath, z.string().max(8000)).refine((v) => Object.keys(v).length <= 5),
    checks: z.array(experimentCheckSchema).min(1).max(5),
    toolFixtures: z.array(toolFixtureSchema).max(16).optional(),
  }).strict()).min(2).max(6),
  maxCallsPerRun: z.number().int().min(2).max(8).default(6),
  maxSeconds: z.number().int().min(30).max(600).default(300),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.cases.map((c) => c.id)).size !== p.cases.length ||
      !p.cases.some((c) => c.partition === "development") || !p.cases.some((c) => c.partition === "holdout")) {
    ctx.addIssue({ code: "custom", message: "Unique cases in development and holdout partitions are required" });
  }
  if (JSON.stringify(p).length > 60_000) ctx.addIssue({ code: "custom", message: "Protocol exceeds 60000 characters" });
  for (const c of p.cases) {
    const fixtures = c.toolFixtures ?? [];
    if (fixtures.length && p.environment !== "scenario") ctx.addIssue({ code: "custom", message: "Tool fixtures require the explicit scenario environment" });
    const keys = fixtures.map((f) => experimentHash([f.toolName, f.input]));
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate tool fixtures are ambiguous" });
    if (fixtures.some((f) => ["read_file", "write_file"].includes(f.toolName))) ctx.addIssue({ code: "custom", message: "File tools execute against the isolated filesystem and cannot be simulated" });
    if (c.checks.filter((v) => "target" in v && v.target === "rubric").length > 1) ctx.addIssue({ code: "custom", message: "Use one rubric per case" });
  }
});
export type ExperimentProtocol = z.infer<typeof experimentProtocolSchema>;
export type ArtifactCheck = z.infer<typeof artifactCheckSchema>;
export type ExperimentCheck = z.infer<typeof experimentCheckSchema>;
export type ToolFixture = z.infer<typeof toolFixtureSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export const experimentHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function experimentApprovalSummary(input: unknown): string[] {
  const protocol = experimentProtocolSchema.safeParse(input);
  if (!protocol.success) return ["Некорректный протокол: выполнение будет отклонено."];
  const p = protocol.data;
  const brief = (s: string, max: number) => {
    const line = s.replace(/[\p{Cc}\p{Cf}]/gu, " ");
    return line.length > max ? line.slice(0, max - 1) + "…" : line;
  };
  return [
    p.environment === "scenario" ? "Симуляция внешних инструментов: тестовые ответы; реальных отправок, поиска и изменений данных нет." : "Изоляция: read_file/write_file; без памяти и реальных отправок.",
    `Бюджет: ${p.maxSeconds} с, до ${p.maxCallsPerRun} вызовов модели на прогон, до 2048 выходных токенов на вызов.`,
    `Baseline и до трёх кандидатов, каждый пример дважды: до ${p.cases.length * 8 * p.maxCallsPerRun} вызовов.`,
    ...p.cases.flatMap((c) => [
      `${c.id} (${c.partition}): ${brief(c.request, 80)}`,
      `Входные файлы: ${brief(Object.keys(c.files).join(", ") || "нет", 70)}`,
      `Ожидания (сокращённо): ${brief(JSON.stringify(c.checks), 120)}`,
      ...(c.toolFixtures?.length ? [`Тестовые ответы (${c.toolFixtures.length}, сокращённо): ${brief(JSON.stringify(c.toolFixtures), 100)}`] : []),
    ]),
    ...(p.cases.some((c) => c.checks.some((v) => "target" in v && v.target === "rubric")) ? ["Качество: отдельный вызов модели по рубрике, внутри бюджета; оценка может ошибаться."] : []),
    `SHA-256 полного протокола: ${experimentHash(p)}`,
  ];
}
export function scoreArtifact(check: ArtifactCheck, content: string | undefined): boolean {
  if (content === undefined) return false;
  if (check.text !== undefined) return content === check.text;
  try { return isDeepStrictEqual(JSON.parse(content), check.json); } catch { return false; }
}
export function planExperiment(protocol: ExperimentProtocol, candidates: readonly string[]) {
  return protocol.cases.flatMap((c) => [0, 1].flatMap((repeat) => {
    const variants = ["baseline", ...candidates];
    if (repeat === 1) variants.reverse();
    return variants.map((variant) => ({ caseId: c.id, partition: c.partition, repeat, variant }));
  }));
}
export function publicExperimentResults(rows: readonly { variant: string; partition: string; status: string; passed: boolean[]; [key: string]: unknown }[]) {
  const groups = new Map<string, { variant: string; partition: string; completed: number; passed: number; unknown: number }>();
  for (const row of rows) {
    const key = `${row.variant}:${row.partition}`;
    const group = groups.get(key) ?? { variant: row.variant, partition: row.partition, completed: 0, passed: 0, unknown: 0 };
    if (row.status === "completed") {
      group.completed++;
      if (row.passed.length && row.passed.every(Boolean)) group.passed++;
    } else group.unknown++;
    groups.set(key, group);
  }
  return [...groups.values()];
}
