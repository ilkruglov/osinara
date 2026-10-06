/**
 * Long-term memory product and embedding configuration.
 *
 * Exports:
 * - `MEMORY_SCOPE_QUOTAS`: agreed maximum record counts by scope.
 * - Retrieval and thread-creation gates, ranking calibration, pagination, the embedder, and chunking.
 * - Timeline-selection limits.
 * - R3 always-on profile subject, claim, character, and inactivity limits.
 * - Durable profile-projection notice delivery lease.
 * - Source-backed thread context, activation, episode, and history budgets.
 * - Durable memory-thread notice delivery lease.
 */
export const MEMORY_SCOPE_QUOTAS = {
  family: 20_000,
  group: 10_000,
  personal: 5_000,
} as const;

export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
export const MEMORY_ATTRIBUTE_MAX_CHARACTERS = 64;
export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;
export const MEMORY_RETRIEVAL_LIMIT = 12;
// Automatic per-turn context enters model input on every step, so it is narrower than tool search.
export const MEMORY_TURN_RETRIEVAL_LIMIT = 8;
// Candidates fetched for the automatic block before retention and exposure filters remove some.
export const MEMORY_TURN_RETRIEVAL_CANDIDATE_LIMIT = MEMORY_TURN_RETRIEVAL_LIMIT * 3;
export const MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 40;
// The semantic branch asks the HNSW index for this many nearest chunks of the authorized records
// and keeps the best chunk of each record. Production (5 October 2026, 4 754 chunks of one
// family): the previous distance over every chunk took 253 ms, the index walk 46 ms, with the
// same forty records; two hundred chunks leave room for records of several chunks each.
export const MEMORY_RETRIEVAL_SEMANTIC_CHUNK_CANDIDATES = 200;

export const CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES = 50;

export const MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS = 1_000;

// Live briefs are generated only for activated threads and contain whole source-backed records.
// Per-turn budgets are prompt-cost budgets: the model can read a full thread through
// read_memory_thread when the automatic brief is not enough.
export const THREAD_CONTEXT_MAX_THREADS = 2;
export const THREAD_CONTEXT_MAX_CHARACTERS = 6_000;
export const THREAD_TITLE_MAX_CHARACTERS = 120;
export const THREAD_PURPOSE_MAX_CHARACTERS = 500;
export const THREAD_BRIEF_MAX_CHARACTERS = 3_000;
export const THREAD_BRIEF_MAX_ITEMS = 20;
export const THREAD_CONTEXT_EPISODES_PER_THREAD = 3;
export const THREAD_EPISODE_MAX_CHARACTERS = 2_000;
export const THREAD_HISTORY_PAGE_MAX_ENTRIES = 20;
export const THREAD_HISTORY_PAGE_MAX_CHARACTERS = 12_000;
export const THREAD_SOURCE_INPUT_MAX_CHARACTERS = 40_000;
// Title against title is passage-to-passage, so creation has its own gate. BERTA value mapped from
// the E5 0.92 by quantile of nearest-neighbour similarity over production records (2 October 2026).
export const THREAD_CREATION_TITLE_MIN_SEMANTIC_SIMILARITY = 0.63;
// Creation uses a conservative lexical gate: false positives stop a write and require clarification.
export const THREAD_PURPOSE_MIN_TRIGRAM_SIMILARITY = 0.9;
export const THREAD_CREATION_CANDIDATE_LIMIT = 3;
export const THREAD_CREATION_MAX_ATTEMPTS = 2;
export const THREAD_CREATION_ATTEMPT_LEASE_MILLISECONDS = 5 * 60 * 1_000;
export const THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Profile context is a bounded read projection; whole claims are skipped rather than truncated.
export const PROFILE_CONTEXT_MAX_SUBJECTS = 4;
export const PROFILE_CONTEXT_MAX_CHARACTERS = 6_000;
export const PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT = 20;
export const PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS = 4_000;
export const PROFILE_SELECTION_DORMANCY_MILLISECONDS = 60 * 24 * 60 * 60 * 1_000;
export const PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Branch gates apply before reciprocal-rank fusion. There is no reranker since 2 October 2026: the
// semantic gate is the only relevance cut. Production on one CPU timed the mmarco reranker out in
// 15 of 16 calls, so the block was E5 >= 0.78 unfiltered (E5 0.78 kept 37 of 40 candidates).
// 0.20 keeps the block's text volume of that production (about 2 300 characters per turn) and
// within it the most relevance: on judged production messages (`.tmp/memeval`, dev 180 / holdout
// 119) strictly relevant records +0.38 / +0.45 per turn, irrelevant ones 3.3 instead of 5.1-5.4.
// Below about 0.19 a match is strictly relevant in 7-8 % of pairs. Recheck against `memory-used`.
export const MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY = 0.2;
// Broad search (`includeWeakMatches`) admits semantic matches down to this gate and labels the ones
// below the strict gate weak.
export const MEMORY_RETRIEVAL_WEAK_MIN_SEMANTIC_SIMILARITY = 0.12;
// A message matches a thread title by the same query-to-passage gate as ordinary retrieval.
export const THREAD_TITLE_MIN_SEMANTIC_SIMILARITY = MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY;
export const MEMORY_RETRIEVAL_RRF_RANK_OFFSET = 60;
export const MEMORY_RETRIEVAL_CONFIRMATION_BOOST = 0.001;
// Retention (ACT-R / Ebbinghaus in closed form): R = exp(-age / S), S = S0 * (1 + ln(1 + n)).
// S0 by record kind in days; only the automatic turn block applies the minimum retention.
export const MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE = "итог обсуждения";
// How a person talks to Mia and what they say about her answers; shown first on their card.
export const MEMORY_COMMUNICATION_STYLE_ATTRIBUTE = "общение с Мией";
export const MEMORY_STABILITY_DAYS_EPISODE = 30;
export const MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY = 60;
export const MEMORY_STABILITY_DAYS_SEMANTIC = 180;
export const MEMORY_RETENTION_RANK_FLOOR = 0.3;
export const MEMORY_AUTO_CONTEXT_MIN_RETENTION = 0.2;
// Model use counts as reinforcement at most once per record in this window (owner's decision,
// 26 September 2026): 0 of 2 526 records had ever been reinforced, since the model never calls
// `remember … reinforces`, so a fact used every day aged exactly like one never used. The window
// keeps the loop short: shown → used → shown again cannot add a reinforcement per turn.
export const MEMORY_USE_REINFORCEMENT_INTERVAL_DAYS = 7;
export const MEMORY_SEMANTIC_KINDS = ["profile", "preference", "fact", "family_shared"] as const;
// Near-duplicate gate at write time; it only surfaces candidates and the model decides. BERTA,
// passage against passage, best pair of chunks (6 October 2026): 3 012 production pairs of one
// subject from different slots at 0.55 and above, 317 labelled blind by deepseek-v4-pro
// (same information or a version of it vs a distinct fact; deepseek-flash agreed on 91 %, kappa
// 0.79). Share of right refusals weighted to the population: 0.39 at 0.60, 0.69 at 0.68, 0.83 at
// 0.72, 0.88 at 0.75, 0.96 at 0.80. One bot handoff chain of 26 September is half the pairs above
// 0.72; without it 0.75 gives 0.75 (24 pairs). A wrong refusal costs one repeat with `distinct`.
export const MEMORY_NEAR_DUPLICATE_SIMILARITY = 0.75;
export const MEMORY_NEAR_DUPLICATE_CANDIDATES = 2;

// BERTA (FRIDA distilled, 768 dimensions, 512 tokens) replaced multilingual-e5-small and the mmarco
// reranker on 2 October 2026: on 119 judged holdout messages nDCG@10 0.489 against 0.407, one
// embedder of ~670 MB instead of two services of ~1.66 GB, no 1.6 s rerank call per turn.
export const MEMORY_EMBEDDING_DIMENSIONS = 768;
export const MEMORY_EMBEDDING_MODEL = "sergeyzh/BERTA";
const MEMORY_EMBEDDING_MODEL_REVISION = "914c8c8aed14042ed890fc2c662d5e9e66b2faa7";
export const MEMORY_EMBEDDING_MODEL_VERSION =
  `${MEMORY_EMBEDDING_MODEL}@${MEMORY_EMBEDDING_MODEL_REVISION}`;
export const MEMORY_EMBEDDING_LEASE_MILLISECONDS = 120_000;
export const MEMORY_EMBEDDING_JOB_BATCH_SIZE = 4;
export const MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE = 8;

// A chunk is whole paragraphs or whole sentences up to this many characters: a thousand is
// about 270 BERTA tokens of Russian prose, under the embedder's 512 with room for text that is
// mostly punctuation; the worker retries a record the embedder still refuses with the narrow
// cap, which fits even text that is emoji throughout (5 October 2026).
export const MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS = 1_000;
export const MEMORY_EMBEDDING_CHUNK_NARROW_MAX_CHARACTERS = 400;
export const MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS = 500;
// A paragraph shorter than this (a heading, a date line) joins the next paragraph's chunk.
export const MEMORY_EMBEDDING_CHUNK_MIN_PARAGRAPH_CHARACTERS = 120;
export const MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS = 120;
// A query is embedded as it is; only an absurdly long one is split, and narrowly.
export const MEMORY_EMBEDDING_QUERY_CHUNK_MAX_CHARACTERS = 400;

// A record shown to the model in the last N turns of the same session stays out of the automatic
// context; the model can still search for it. Production showed the same three facts 50 times a day.
export const MEMORY_EXPOSURE_WINDOW_TURNS = 10;
// The current author's own profile card returns after this many turns unless they became the subject.
export const PROFILE_AUTHOR_CARD_WINDOW_TURNS = 20;
