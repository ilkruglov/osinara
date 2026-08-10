/**
 * Shared model-facing `remember` input contract.
 *
 * Exports:
 * - `memorySubjectSchema`: explicit current-author, verified-ref, label, or subjectless intent.
 * - `memoryThreadSchema`: atomic thread create/attach contract.
 * - `rememberInputSchema`: trusted personal/family/group tool input.
 * - `externalRememberInputSchema`: exact external-group presentation contract.
 * - `RememberInput`: parsed trusted tool input type.
 */
import { z } from "zod";

import {
  THREAD_PURPOSE_MAX_CHARACTERS,
  THREAD_TITLE_MAX_CHARACTERS,
} from "./memory-config.js";
import { THREAD_REF_PATTERN } from "./memory-thread-query-repository.js";

const MEMORY_CONTENT_MAX_CHARACTERS = 4_000;
const SUBJECT_LABEL_MAX_CHARACTERS = 200;
export const MEMORY_SUBJECT_REF_PATTERN = /^subj_[0-9a-f]{32}$/u;

export const memorySubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_author") }).strict(),
  z.object({
    kind: z.literal("verified_ref"),
    subjectRef: z.string().regex(MEMORY_SUBJECT_REF_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal("label"),
    label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX_CHARACTERS),
  }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const threadRoleSchema = z.enum([
  "goal", "constraint", "method", "decision", "episode", "outcome", "lesson", "open_loop",
]);

export const memoryThreadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("attach"),
    role: threadRoleSchema,
    threadRef: z.string().regex(THREAD_REF_PATTERN),
  }).strict(),
  z.object({
    action: z.literal("create"),
    identity: z.enum(["subject", "project"]).optional(),
    parentThreadRef: z.string().regex(THREAD_REF_PATTERN).optional(),
    purpose: z.string().trim().min(1).max(THREAD_PURPOSE_MAX_CHARACTERS),
    role: threadRoleSchema,
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_CHARACTERS),
  }).strict().refine(
    (input) => input.parentThreadRef === undefined || input.identity === undefined,
    { message: "Для subthread identity определяется только проверенной родительской нитью" },
  ),
]);

function createRememberInputSchema(scope: z.ZodType<"family" | "group" | "personal">) {
  return z.object({
    basis: z.enum(["agent_inferred", "user_requested"]),
    content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARACTERS),
    kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]),
    scope,
    sensitivity: z.enum(["normal", "sensitive"]),
    subject: memorySubjectSchema,
    thread: memoryThreadSchema.optional(),
  }).strict().superRefine((input, context) => {
    const create = input.thread?.action === "create" ? input.thread : null;
    if (create?.identity === "project" && input.subject.kind !== "none") {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Project-thread требует subject.kind=none",
        path: ["subject"],
      });
    }
    if (input.subject.kind === "label" && input.thread !== undefined) {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Текстовая метка не задаёт identity нити",
        path: ["subject"],
      });
    }
    if (input.scope === "personal" && create?.identity === "project") {
      context.addIssue({
        code: "custom",
        message: "AGENT_MEMORY_THREAD_INPUT_INVALID: Project identity недоступна в личной записи",
        path: ["thread", "identity"],
      });
    }
  });
}

export const rememberInputSchema = createRememberInputSchema(
  z.enum(["personal", "family", "group"]),
);
export const externalRememberInputSchema = createRememberInputSchema(z.literal("group"));
export type RememberInput = z.infer<typeof rememberInputSchema>;
