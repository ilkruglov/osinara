/**
 * Near-duplicate gate integration tests.
 *
 * Constructs covered:
 * - A close active record of the same subject blocks a plain insert with the candidate list.
 * - `reinforces` bumps the existing record; `distinct` inserts anyway.
 * - A write that opens a new slot is gated against the subject's other slots («дети» next to
 *   «семья»); a write into an existing slot versions it through `slotUpdate` without the gate.
 * - A slotted write meets only slotted records; the candidate is embedded as a passage, the way
 *   stored records are, and the best pair of chunks is compared with the threshold.
 * - A replay of a stored operation does not embed.
 * - A different subject or an episode is never gated.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async (texts: readonly string[]) =>
    texts.map(() => [1, ...Array.from({ length: 767 }, () => 0)])),
}));

import { closeDatabase, database } from "./database.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

type Fixture = Awaited<ReturnType<typeof createMainAgentMemoryFixture>>;

function claim(
  fixture: Fixture,
  content: string,
  operationKey: string,
  overrides: Partial<CreateMemoryInput> & { subject?: CreateMemoryInput["explicitSource"] extends infer S ? S extends { subject: infer U } ? U : never : never } = {},
): CreateMemoryInput {
  const { subject, ...rest } = overrides;
  return {
    confirmation: "model_high",
    content,
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: subject ?? { kind: "label", label: "Гоша" },
      timelineEntryId: fixture.timelineEntryId,
    },
    kind: "family_shared",
    operationKey,
    provenance: { sessionId: "eve-session-near", turnId: `eve-turn-${operationKey}` },
    scope: "family",
    sensitivity: "normal",
    source: `eve:eve-session-near:eve-turn-${operationKey}`,
    ...rest,
  };
}

async function indexWithVector(memoryId: string, first: number): Promise<void> {
  const embedding = `[${[first, ...Array.from({ length: 767 }, () => 0)].join(",")}]`;
  await database().query(
    `INSERT INTO memory_embedding_chunks
       (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
     VALUES ($1, 0, 'chunk', 0, 5, $2::vector, $3)`,
    [memoryId, embedding, MEMORY_EMBEDDING_MODEL_VERSION],
  );
  await database().query("UPDATE memory_items SET embedding_status = 'indexed' WHERE id = $1", [memoryId]);
}

describeWithDatabase("near-duplicate gate", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE memory_embedding_chunks, users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("refuses a near duplicate until the writer decides, then reinforces or inserts", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша, кубинский амазон, живёт у семьи дома", "near-1"));
    await indexWithVector(first.id, 1);

    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Семейный попугай Гоша, кубинский амазон, живёт дома", "near-2")))
      .rejects.toMatchObject({
        candidates: [expect.objectContaining({ memoryRef: first.memoryRef })],
        code: "AGENT_MEMORY_NEAR_DUPLICATE",
        // Thrown errors reach the log whole; the memory text stays out of the message.
        message: "AGENT_MEMORY_NEAR_DUPLICATE",
      });
    await expect(database().query(
      "SELECT count(*)::int AS total FROM memory_items WHERE family_id = $1",
      [fixture.familyId],
    )).resolves.toMatchObject({ rows: [{ total: 1 }] });

    const reinforced = await memoryRepository.reinforceByRef(fixture.auth, {
      memoryRef: first.memoryRef,
      provenance: { sessionId: "eve-session-near", turnId: "eve-turn-near-3" },
    });
    expect(reinforced.memoryRef).toBe(first.memoryRef);
    await expect(database().query(
      "SELECT reinforcement_count FROM memory_items WHERE id = $1",
      [first.id],
    )).resolves.toMatchObject({ rows: [{ reinforcement_count: 1 }] });

    const distinct = await memoryRepository.create(fixture.auth, claim(fixture, "Семейный попугай Гоша, кубинский амазон, живёт дома", "near-4", { distinct: true }));
    expect(distinct.id).not.toBe(first.id);

    // A slotted write meets only slotted records: an unslotted one could not take the refinement
    // (`slotUpdate` names records of one slot, and the silent review has no edit).
    const opened = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт на жёрдочке, клетка только на ночь", "near-5", { attribute: "содержание" }));
    await indexWithVector(opened.id, 1);

    // A new slot of the same subject is checked against the other slots, as a passage.
    vi.mocked(embedMemoryPassages).mockClear();
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша спит в клетке только ночью", "near-6", { attribute: "быт" })))
      .rejects.toMatchObject({
        candidates: [expect.objectContaining({ memoryRef: opened.memoryRef })],
        code: "AGENT_MEMORY_NEAR_DUPLICATE",
      });
    expect(vi.mocked(embedMemoryPassages).mock.calls[0]![0]).toEqual(["Гоша спит в клетке только ночью"]);

    // The way forward the refusal names: the candidate's slot through slotUpdate, without the gate.
    const added = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша спит в клетке только ночью", "near-7", {
      attribute: "содержание",
      slotUpdate: { action: "add", previousMemoryRefs: [opened.memoryRef] },
    }));
    expect(added.id).not.toBe(opened.id);

    // A replay of a plain create answers from the stored operation and does not embed again.
    vi.mocked(embedMemoryPassages).mockClear();
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша, кубинский амазон, живёт у семьи дома", "near-1")))
      .resolves.toMatchObject({ id: first.id });
    expect(embedMemoryPassages).not.toHaveBeenCalled();
  });

  it("compares the best pair of chunks with the threshold", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const base = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт у семьи дома", "edge-1"));
    await indexWithVector(base.id, 1);
    // Unit vectors at a given cosine to the stored [1, 0, …].
    const at = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine), ...Array.from({ length: 766 }, () => 0)];

    vi.mocked(embedMemoryPassages).mockResolvedValueOnce([at(0.74)]);
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша любит семечки", "edge-2")))
      .resolves.toMatchObject({ kind: "family_shared" });
    vi.mocked(embedMemoryPassages).mockResolvedValueOnce([at(0.76)]);
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша любит орехи", "edge-3")))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_NEAR_DUPLICATE" });

    // A long record is chunked like a stored one; its closest chunk decides.
    const paragraph = "Гоша любит семечки, орехи и яблоко, а по утрам громко зовёт всех завтракать. ".repeat(9).trim();
    vi.mocked(embedMemoryPassages).mockImplementationOnce(async (texts) =>
      texts.map((_, index) => at(index === texts.length - 1 ? 0.9 : 0.1)));
    await expect(memoryRepository.create(fixture.auth, claim(fixture, `${paragraph}\n\n${paragraph}`, "edge-4")))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_NEAR_DUPLICATE" });
    expect(vi.mocked(embedMemoryPassages).mock.calls.at(-1)![0].length).toBeGreaterThan(1);
  });

  it("never gates another subject or an episode", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const first = await memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт у семьи дома", "other-1"));
    await indexWithVector(first.id, 1);

    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша живёт у семьи дома", "other-2", {
      subject: { kind: "label", label: "Кеша" },
    }))).resolves.toMatchObject({ kind: "family_shared" });
    await expect(memoryRepository.create(fixture.auth, claim(fixture, "Гоша сегодня летал по комнате", "other-3", {
      kind: "episode",
    }))).resolves.toMatchObject({ kind: "episode" });
  });
});
