/**
 * Stable application configuration.
 *
 * Exports:
 * - Agent compaction, session lifecycle, attachment, update, and timeout constants.
 * - Internal service locations and sandbox runner execution limits.
 * - Telegram group journal and proactive delivery model-context limits.
 * - Cross-process advisory-lock namespaces for sensitive workspace state.
 * - Bounded credentialed Google Workspace command execution.
 * - `requireRuntimeEnvironment`: reads required environment-specific values.
 */
import { z } from "zod";

export const AGENT_COMPACTION_THRESHOLD = 0.75;
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED = 2;
export const GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;
export const SANDBOX_RUNNER_BASE_URL = "http://sandbox-runner:8080";
export const SESSION_INACTIVITY_DAYS = 30;
export const SESSION_GROUP_ROTATION_LOCK_HASH_SEED = 3;
export const SESSION_MAX_COMPLETED_TURNS = 250;
export const SESSION_RETENTION_LEASE_MS = 15 * 60 * 1_000;
export const SESSION_RETENTION_DAYS = 90;
export const SESSION_TASK_ABANDONED_DAYS = 7;
export const SESSION_TASK_MAX_ACTIVE_PER_GROUP_TOPIC = 25;
export const SESSION_TASK_SWEEP_BATCH_SIZE = 100;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS = 30;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS = 12_000;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS = 10;
export const PROACTIVE_DELIVERY_HISTORY_DEFAULT_LIMIT = 10;
export const PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT = 50;
export const SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024;
export const SOFTWARE_UPDATE_HTTP_TIMEOUT_MS = 15_000;
export const SOFTWARE_UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS = 12_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES = 50;
export const TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES = 1_000;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_DEFAULT_LIMIT = 50;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_MAX_LIMIT = 50;
export const TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED = 1;
export const TELEGRAM_INGRESS_LEASE_MS = 15 * 60 * 1_000;
export const TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE = 1;
export const TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_DELETION_LEASE_MS = 15 * 60 * 1_000;
export const WORKSPACE_TOOL_MAX_TEXT_BYTES = 1024 * 1024;
export const VISION_MAX_FILE_BYTES = 10_000_000;

const runtimeEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    GROQ_API_KEY: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    INVITATION_SIGNING_SECRET: z.string().min(32),
    MODEL_API_KEY: z.string().regex(/^\S+$/u),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_BOT_USERNAME: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1),
  });

export function requireRuntimeEnvironment() {
  const parsed = runtimeEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `AGENT_REQUIRED_CONFIG_MISSING: Отсутствуют обязательные настройки: ${fields}`,
    );
  }
  return parsed.data;
}
