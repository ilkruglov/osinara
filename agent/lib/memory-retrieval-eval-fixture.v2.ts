/**
 * Production-derived identity hard negatives for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_V2`: fictional project, framework, link, and skill distractors.
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V2`: identity controls and abstention-required near misses.
 * - `MEMORY_RETRIEVAL_V2_GATES`: measured floor of strict search on identity near misses.
 */
import type {
  MemoryRetrievalEvalQuery,
  MemoryRetrievalEvalRecord,
} from "./memory-retrieval-eval-fixture.v1.js";

// Names mirror the observed confusion classes, while URLs and statements remain synthetic.
export const MEMORY_RETRIEVAL_EVAL_RECORDS_V2: readonly MemoryRetrievalEvalRecord[] = [
  {
    content: "Репозиторий проекта Orca: https://code.example/orca/runtime.",
    key: "orca-repository",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    content: "Документация фреймворка Eve опубликована по адресу https://docs.example/eve.",
    key: "eve-documentation",
    updatedAt: "2026-08-02T10:00:00.000Z",
  },
  {
    content: "Навык Pinecone Reader установлен локально из проверенного пакета навыков.",
    key: "local-skill-package",
    updatedAt: "2026-08-03T10:00:00.000Z",
  },
  {
    content: "Ссылка на макет семейного календаря: https://design.example/family-calendar.",
    key: "calendar-design-link",
    updatedAt: "2026-08-04T10:00:00.000Z",
  },
] as const;

export const MEMORY_RETRIEVAL_EVAL_QUERIES_V2: readonly MemoryRetrievalEvalQuery[] = [
  {
    category: "exact",
    expectedKeys: ["orca-repository"],
    key: "identity-control-orca-repository",
    text: "Где репозиторий Orca?",
  },
  {
    category: "exact",
    expectedKeys: ["eve-documentation"],
    key: "identity-control-eve-documentation",
    text: "Где документация Eve?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-osinara-vs-orca",
    text: "Осинара, где твой репозиторий?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-iva-vs-eve",
    text: "Что известно про ассистента Иву?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-project-repository-vs-skill",
    text: "Где репозиторий навыка Осинары?",
  },
  {
    category: "negative",
    expectedKeys: [],
    key: "hard-negative-source-link-vs-design-link",
    text: "Дай ссылку на исходный код Осинары.",
  },
] as const;

// Strict search must abstain on these near misses; broad search separately guards recall.
// The mmarco reranker closed all four near misses in CI, but on the one-CPU production it timed
// out in 15 of 16 calls (2 October 2026), so production never had that guarantee. BERTA alone
// abstains on one of four: "Дай ссылку на исходный код Осинары" scores 0.44 against the Orca
// repository, close to the 0.51 of the real question about it, so no similarity gate separates
// them. The floor keeps this measured level from getting worse; identity checks are separate work.
export const MEMORY_RETRIEVAL_V2_GATES = {
  hardNegativeEmptyRateMinimum: 0.25,
  identityControlRecallAt5Minimum: 1,
} as const;
