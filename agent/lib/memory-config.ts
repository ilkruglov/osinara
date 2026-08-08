/**
 * Long-term memory product and embedding configuration.
 *
 * Exports:
 * - `MEMORY_SCOPE_QUOTAS`: agreed maximum record counts by scope.
 * - Retrieval gates, ranking calibration, pagination, E5 model, chunking, and worker constants.
 * - Extraction snapshot, structured-output, job-attempt, evidence, lease, and worker readiness limits.
 * - R3 always-on profile subject, claim, character, and inactivity limits.
 * - Durable profile-projection notice delivery lease.
 * - R4/R5 bounded consolidation candidate, provider, and lease limits.
 * - R6/R7 thread discovery, live brief, activation, episode, and deepening budgets.
 * - Durable memory-thread notice delivery lease.
 */
export const MEMORY_SCOPE_QUOTAS = {
  family: 20_000,
  group: 10_000,
  personal: 5_000,
} as const;

export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;
export const MEMORY_RETRIEVAL_LIMIT = 12;
export const MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 40;

// Extraction uses the same bounded group delta envelope, but owns an independent durable lifecycle.
export const MEMORY_EXTRACTION_SNAPSHOT_MAX_ENTRIES = 50;
export const MEMORY_EXTRACTION_INPUT_MAX_CHARACTERS = 12_000;
export const MEMORY_EXTRACTION_OUTPUT_MAX_CANDIDATES = 12;
export const MEMORY_EXTRACTION_SUBJECT_LABEL_MAX_CHARACTERS = 200;
export const MEMORY_EXTRACTION_VERSION_MAX_CHARACTERS = 120;
export const MEMORY_EXTRACTION_MAX_OPERATOR_ATTEMPTS = 3;
export const MEMORY_EXTRACTION_JOB_LEASE_MILLISECONDS = 120_000;
export const MEMORY_EXTRACTION_MODEL_TIMEOUT_MILLISECONDS = 45_000;
export const MEMORY_EXTRACTION_MODEL_MAX_OUTPUT_TOKENS = 16_384;
export const MEMORY_EXTRACTION_CATCH_UP_CONVERSATIONS_PER_PASS = 8;
export const MEMORY_EXTRACTION_EXTRACTOR_VERSION = "semantic-extractor-v1";
export const MEMORY_EXTRACTION_SCHEMA_VERSION = "memory-candidate-v2";
export const MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS = 1_000;
export const MEMORY_EXTRACTION_WORKER_READY_PATH = "/tmp/osinara-memory-extraction-worker-ready";
export const MEMORY_EXTRACTION_WORKER_STABILITY_MILLISECONDS = 30_000;
export const MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS = 1_000;
export const MEMORY_APPROVAL_NOTICE_MAX_ITEMS = 10;
export const MEMORY_CANDIDATE_RESOLUTION_LEASE_MILLISECONDS = 60_000;

// Consolidation is one strict provider pass over a small same-scope/same-subject candidate set.
export const MEMORY_CONSOLIDATION_CANDIDATE_LIMIT = 8;
export const MEMORY_CONSOLIDATION_MIN_TRIGRAM_SIMILARITY = 0.3;
export const MEMORY_CONSOLIDATION_JOB_LEASE_MILLISECONDS = 120_000;
export const MEMORY_CONSOLIDATION_MODEL_TIMEOUT_MILLISECONDS = 30_000;
export const MEMORY_CONSOLIDATION_MODEL_MAX_OUTPUT_TOKENS = 2_048;

// Thread discovery is broad-first and uses one bounded classifier after deterministic candidate gates.
export const THREAD_DISCOVERY_MIN_CLAIMS = 3;
export const THREAD_DISCOVERY_MIN_SOURCE_BATCHES = 2;
export const THREAD_DISCOVERY_LOOKBACK_DAYS = 90;
export const THREAD_DISCOVERY_CANDIDATE_LIMIT = 12;
export const THREAD_DISCOVERY_MAX_OPERATOR_ATTEMPTS = 3;
export const THREAD_DISCOVERY_JOB_LEASE_MILLISECONDS = 120_000;
export const THREAD_DISCOVERY_MODEL_TIMEOUT_MILLISECONDS = 30_000;
export const THREAD_DISCOVERY_MODEL_MAX_OUTPUT_TOKENS = 2_048;
export const THREAD_DISCOVERY_SCHEMA_VERSION = "memory-thread-discovery-v1";

// Live briefs are generated only for activated threads and contain whole source-backed records.
export const THREAD_CONTEXT_MAX_THREADS = 2;
export const THREAD_CONTEXT_MAX_CHARACTERS = 16_000;
export const THREAD_BRIEF_MAX_CHARACTERS = 6_000;
export const THREAD_BRIEF_MAX_ITEMS = 20;
export const THREAD_CONTEXT_EPISODES_PER_THREAD = 3;
export const THREAD_EPISODE_MAX_CHARACTERS = 2_000;
export const THREAD_HISTORY_PAGE_MAX_ENTRIES = 20;
export const THREAD_HISTORY_PAGE_MAX_CHARACTERS = 12_000;
export const THREAD_BRIEF_MODEL_TIMEOUT_MILLISECONDS = 30_000;
export const THREAD_BRIEF_MODEL_MAX_OUTPUT_TOKENS = 4_096;
export const THREAD_BRIEF_SCHEMA_VERSION = "memory-thread-brief-v1";
export const THREAD_BRIEF_JOB_LEASE_MILLISECONDS = 120_000;
export const THREAD_BRIEF_INPUT_MAX_CHARACTERS = 40_000;
export const THREAD_TITLE_MIN_SEMANTIC_SIMILARITY = 0.78;
export const THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Profile context is a bounded read projection; whole claims are skipped rather than truncated.
export const PROFILE_CONTEXT_MAX_SUBJECTS = 4;
export const PROFILE_CONTEXT_MAX_CHARACTERS = 12_000;
export const PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT = 30;
export const PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS = 8_000;
export const PROFILE_SELECTION_DORMANCY_MILLISECONDS = 60 * 24 * 60 * 60 * 1_000;
export const PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Branch gates are calibrated by memory-retrieval-v1 and apply before reciprocal-rank fusion.
export const MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY = 0.78;
export const MEMORY_RETRIEVAL_RRF_RANK_OFFSET = 60;
export const MEMORY_RETRIEVAL_CONFIRMATION_BOOST = 0.001;
export const MEMORY_RETRIEVAL_RECENCY_BOOST = 0.0005;
export const MEMORY_RETRIEVAL_RECENCY_DECAY_SECONDS = 31_557_600;

export const MEMORY_EMBEDDING_DIMENSIONS = 384;
export const MEMORY_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";
export const MEMORY_EMBEDDING_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
export const MEMORY_EMBEDDING_MODEL_VERSION =
  `${MEMORY_EMBEDDING_MODEL}@${MEMORY_EMBEDDING_MODEL_REVISION}`;
export const MEMORY_EMBEDDING_LEASE_MILLISECONDS = 120_000;
export const MEMORY_EMBEDDING_JOB_BATCH_SIZE = 4;
export const MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE = 8;

// Character bounds guarantee E5's 512-token limit even for adversarial punctuation-heavy text.
export const MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS = 400;
export const MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS = 280;
export const MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS = 80;
