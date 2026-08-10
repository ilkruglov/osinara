/**
 * Model-facing memory tool result contract tests.
 *
 * Constructs covered:
 * - `remember`: persists the main agent's source-backed decision and optional atomic thread action.
 * - Tool results expose only opaque memory/thread refs and preserve immediate undo guidance.
 * - `list_memories`: projects internal records while preserving an opaque pagination cursor.
 * - `search_memories`: returns the already-safe retrieval DTO unchanged.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createMemory, listMemories, requireApprovalEvidence, retrieveMemories } = vi.hoisted(() => ({
  createMemory: vi.fn(),
  listMemories: vi.fn(),
  requireApprovalEvidence: vi.fn(),
  retrieveMemories: vi.fn(),
}));

vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", scopes: ["personal"] }),
  requireWritableScope: (_authorization: unknown, scope: string) => scope,
}));
vi.mock("./memory-content-policy.js", () => ({
  requireAllowedMemoryContent: (content: string) => content,
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { create: createMemory, list: listMemories },
}));
vi.mock("./memory-retrieval.js", () => ({
  retrieveRelevantMemories: retrieveMemories,
}));
vi.mock("./session-auth.js", () => ({
  resolveSessionCaller: () => ({
    attributes: {
      telegramConversationId: "conversation-1",
      telegramTimelineEntryId: "timeline-entry-1",
    },
  }),
}));
vi.mock("./require-tool-approval-evidence.js", () => ({
  requireToolApprovalEvidence: requireApprovalEvidence,
}));

import listMemoriesTool from "./tools/list_memories.js";
import remember from "./tools/remember.js";
import searchMemories from "./tools/search_memories.js";

const MEMORY_ID = "00000000-0000-4000-8000-000000000001";
const MEMORY_REF = "mem_0123456789abcdef0123456789abcdef";
const internalMemory = {
  author: { status: "current_member", telegramUserId: "7100000001", userId: "user-1" },
  confirmation: "user_confirmed",
  content: "Пользователь любит чай",
  createdAt: "2026-08-01T10:00:00.000Z",
  embeddingStatus: "pending",
  id: MEMORY_ID,
  kind: "preference",
  memoryRef: MEMORY_REF,
  messageThreadId: "42",
  scope: "personal",
  sensitivity: "normal",
  source: "eve:session-internal:turn-internal",
  updatedAt: "2026-08-01T10:00:00.000Z",
  sourceEvidence: {
    authorLabel: "Анна",
    kind: "reported",
    notice: "Сообщено другим участником; не является подтверждением субъекта.",
    observedAt: "2026-08-01T09:55:00.000Z",
  },
  thread: {
    action: "created" as const,
    threadRef: "thread_22222222222222222222222222222222",
  },
} as const;
const context = {
  callId: "call-1",
  session: { id: "session-internal", turn: { id: "turn-internal" } },
} as ToolContext;

describe("model-facing memory tool results", () => {
  beforeEach(() => {
    createMemory.mockReset();
    listMemories.mockReset();
    requireApprovalEvidence.mockReset();
    requireApprovalEvidence.mockResolvedValue(undefined);
    retrieveMemories.mockReset();
  });

  it("requires exact approval evidence before a sensitive remember write", async () => {
    createMemory.mockResolvedValue(internalMemory);
    const input = {
      basis: "agent_inferred" as const,
      content: internalMemory.content,
      kind: "preference" as const,
      scope: "personal" as const,
      sensitivity: "sensitive" as const,
      subject: { kind: "current_author" as const },
    };

    await remember.execute(input, context);

    expect(requireApprovalEvidence).toHaveBeenCalledWith(context, "remember", input);
    expect(requireApprovalEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(createMemory.mock.invocationCallOrder[0]!);
  });

  it("rejects impossible thread identities before tool execution", () => {
    const schema = remember.inputSchema as z.ZodType;
    const input = {
      basis: "user_requested",
      content: "Начинаю отдельную длительную тему",
      kind: "fact",
      scope: "personal",
      sensitivity: "normal",
      subject: { kind: "current_author" },
      thread: {
        action: "create",
        purpose: "Сохранять цели и результаты",
        role: "goal",
        title: "Здоровье",
      },
    };

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, subject: undefined }).success).toBe(false);
    const personalProject = schema.safeParse({
      ...input,
      subject: { kind: "none" },
      thread: { ...input.thread, identity: "project" },
    });
    const freeLabelThread = schema.safeParse({
      ...input,
      subject: { kind: "label", label: "Пух" },
      thread: { ...input.thread, identity: "subject" },
    });
    expect(personalProject.success).toBe(false);
    expect(freeLabelThread.success).toBe(false);
    if (!personalProject.success) {
      expect(personalProject.error.issues[0]!.message)
        .toContain("AGENT_MEMORY_THREAD_INPUT_INVALID");
    }
    if (!freeLabelThread.success) {
      expect(freeLabelThread.error.issues[0]!.message)
        .toContain("AGENT_MEMORY_THREAD_INPUT_INVALID");
    }
  });

  it("returns only a safe item and opaque undo ref from remember", async () => {
    createMemory.mockResolvedValue(internalMemory);

    const result = await remember.execute({
      basis: "agent_inferred",
      content: internalMemory.content,
      kind: "preference",
      scope: "personal",
      sensitivity: "normal",
      subject: {
        kind: "verified_ref",
        subjectRef: "subj_11111111111111111111111111111111",
      },
      thread: {
        action: "create",
        identity: "subject",
        purpose: "Сохранять предпочтения пользователя",
        role: "constraint",
        title: "Чай",
      },
    }, context);

    expect(result.item).toEqual({
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: internalMemory.content,
      createdAt: internalMemory.createdAt,
      kind: "preference",
      memoryRef: MEMORY_REF,
      scope: "personal",
      sensitivity: "normal",
      updatedAt: internalMemory.updatedAt,
    });
    expect(result.thread).toEqual(internalMemory.thread);
    expect(JSON.stringify(result)).not.toContain(MEMORY_ID);
    expect(result.notice).toContain(`memoryRef ${MEMORY_REF}`);
    expect(createMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confirmation: "model_high",
        explicitSource: {
          conversationId: "conversation-1",
          subject: {
            kind: "verified_ref",
            subjectRef: "subj_11111111111111111111111111111111",
          },
          timelineEntryId: "timeline-entry-1",
        },
        thread: {
          action: "create",
          identity: "subject",
          purpose: "Сохранять предпочтения пользователя",
          role: "constraint",
          title: "Чай",
        },
      }),
    );
  });

  it("returns only safe list items and keeps the repository cursor", async () => {
    listMemories.mockResolvedValue({ items: [internalMemory], nextCursor: "opaque-cursor" });

    const result = await listMemoriesTool.execute({ limit: 20 }, context);

    expect(result).toEqual({
      items: [{
        authorStatus: "current_member",
        confirmation: "user_confirmed",
        content: internalMemory.content,
        createdAt: internalMemory.createdAt,
        evidence: internalMemory.sourceEvidence,
        kind: "preference",
        memoryRef: MEMORY_REF,
        scope: "personal",
        sensitivity: "normal",
        updatedAt: internalMemory.updatedAt,
      }],
      nextCursor: "opaque-cursor",
    });
    expect(JSON.stringify(result)).not.toMatch(/user-1|7100000001|session-internal|turn-internal/u);
  });

  it("returns only the safe retrieval DTO from search_memories", async () => {
    const safeMemory = {
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: internalMemory.content,
      createdAt: internalMemory.createdAt,
      kind: "preference",
      memoryRef: MEMORY_REF,
      scope: "personal",
      sensitivity: "normal",
      updatedAt: internalMemory.updatedAt,
    };
    retrieveMemories.mockResolvedValue([safeMemory]);

    await expect(searchMemories.execute({ query: "чай" }, context)).resolves.toEqual([safeMemory]);
    expect(JSON.stringify(await retrieveMemories.mock.results[0]!.value)).not.toContain(MEMORY_ID);
  });
});
