/**
 * Authored skill repository integration tests.
 *
 * Constructs covered:
 * - Publish creates version 1, republish bumps the version, the same operation key replays.
 * - Rollback copies an old version into a new one; retire hides the skill from resolver packages.
 * - Only a current owner may mutate; a member of the family is refused.
 * - The active-skill limit is enforced per family.
 * - Usage rows come from observed loads and take the latest outcome per conversation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { AUTHORED_SKILL_LIMITS } from "./authored-skill-contract.js";
import { authoredSkillRepository } from "./authored-skill-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

const KNOWN = new Set(["generate_image", "send_workspace_file"]);
const MARKDOWN = [
  "## Когда применять", "Когда просят открытку.",
  "## Шаги", "1. Вызови `generate_image`.", "2. Отправь `send_workspace_file`.",
  "## Проверка результата", "Картинка без текста.",
].join("\n");

function draft(name: string, changeNote = "Первая версия") {
  return {
    changeNote,
    description: "Открытка к празднику через Flux",
    files: {},
    markdown: MARKDOWN,
    name,
    trialSummary: "Сгенерировала одну открытку, отправила в чат.",
  };
}

const provenance = { eveSessionId: "eve-skill-session", eveTurnId: "turn-skill" };

describeWithDatabase("authored skill repository", () => {
  let owner: FamilyCaller;
  let familyId: string;
  let conversationId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    const fixture = await createMainAgentMemoryFixture();
    owner = { familyId: fixture.familyId, role: "owner", userId: fixture.userId };
    familyId = fixture.familyId;
    conversationId = fixture.conversationId;
  });

  afterAll(closeDatabase);

  it("publishes, republishes as a new version and replays the same operation key", async () => {
    const first = await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    expect(first).toEqual({ name: "birthday-card", replayed: false, version: 1 });

    const replay = await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    expect(replay).toEqual({ name: "birthday-card", replayed: true, version: 1 });

    const second = await authoredSkillRepository.publish(owner, draft("birthday-card", "Короче шаги"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    });
    expect(second).toEqual({ name: "birthday-card", replayed: false, version: 2 });

    const listed = await authoredSkillRepository.list(familyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "birthday-card", usageCount: 0, version: 2 });
    const read = await authoredSkillRepository.read(familyId, "birthday-card", 1);
    expect(read).toMatchObject({ changeNote: "Первая версия", version: 1 });
  });

  it("rolls back by creating a new version with the old content and retires from packages", async () => {
    await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    await authoredSkillRepository.publish(owner, {
      ...draft("birthday-card", "Другое описание"), description: "Версия два",
    }, { knownToolNames: KNOWN, operationKey: "call-2", provenance });

    const rolled = await authoredSkillRepository.rollback(owner, {
      name: "birthday-card", operationKey: "call-3", provenance, version: 1,
    });
    expect(rolled).toEqual({ name: "birthday-card", replayed: false, version: 3 });
    const packages = await authoredSkillRepository.activePackages(familyId);
    expect(packages).toEqual([expect.objectContaining({
      description: "Открытка к празднику через Flux", name: "birthday-card",
    })]);

    await authoredSkillRepository.retire(owner, { name: "birthday-card" });
    await expect(authoredSkillRepository.activePackages(familyId)).resolves.toEqual([]);
    await expect(authoredSkillRepository.read(familyId, "birthday-card"))
      .rejects.toMatchObject({ code: "AGENT_SKILL_NOT_FOUND" });
    await expect(authoredSkillRepository.rollback(owner, {
      name: "birthday-card", operationKey: "call-4", provenance, version: 1,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_NOT_FOUND" });
  });

  it("refuses a family member and a stale owner", async () => {
    const member: FamilyCaller = { ...owner, role: "member" };
    await expect(authoredSkillRepository.publish(member, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });

    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [familyId, owner.userId],
    );
    await expect(authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });
  });

  it("enforces the active-skill limit per family", async () => {
    for (let index = 0; index < AUTHORED_SKILL_LIMITS.activeSkillsPerFamily; index += 1) {
      await database().query(
        `INSERT INTO authored_skills (family_id, name, description, markdown, version, status)
         VALUES ($1, $2, 'd', 'm', 1, 'active')`,
        [familyId, `skill-${index}`],
      );
    }
    await expect(authoredSkillRepository.publish(owner, draft("one-more"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    })).rejects.toMatchObject({ code: "AGENT_SKILL_LIMIT_REACHED" });
  });

  it("records observed loads and the latest outcome per conversation", async () => {
    await authoredSkillRepository.publish(owner, draft("birthday-card"), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    await expect(authoredSkillRepository.recordUsage({
      conversationId, eveSessionId: "s1", eveTurnId: "t1", familyId, skillName: "unknown-skill",
    })).resolves.toBe(false);
    await expect(authoredSkillRepository.recordUsage({
      conversationId, eveSessionId: "s1", eveTurnId: "t1", familyId, skillName: "birthday-card",
    })).resolves.toBe(true);
    await expect(authoredSkillRepository.recordUsage({
      conversationId: null, eveSessionId: "s2", eveTurnId: "t2", familyId, skillName: "birthday-card",
    })).resolves.toBe(true);

    await expect(authoredSkillRepository.recordOutcome(owner, {
      conversationId, name: "birthday-card", note: "картинка с текстом", outcome: "failed",
    })).resolves.toEqual({ name: "birthday-card", outcome: "failed", usageFound: true });

    const outcomes = await database().query<{ conversation_id: string | null; outcome: string }>(
      `SELECT usage.conversation_id, usage.outcome FROM authored_skill_usage AS usage
        ORDER BY usage.loaded_at`,
    );
    expect(outcomes.rows).toEqual([
      { conversation_id: conversationId, outcome: "failed" },
      { conversation_id: null, outcome: "unknown" },
    ]);
    const listed = await authoredSkillRepository.list(familyId);
    expect(listed[0]).toMatchObject({ lastOutcome: "unknown", usageCount: 2 });
  });
});
