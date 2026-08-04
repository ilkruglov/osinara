/**
 * External-group task boundary tests.
 *
 * Constructs covered:
 * - The purpose list is derived from the effective allowlist, in human terms without tool names.
 * - Useful in-scope work is not rejected merely because it needs research or a file artifact.
 * - Refusal and people rules preserve access, representation and anti-profiling boundaries.
 * - A revoked capability removes its purpose line, so the stated scope never overstates access.
 */
import { describe, expect, it } from "vitest";

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  EXTERNAL_PEOPLE_RULES,
  EXTERNAL_TASK_BOUNDARIES,
  externalPurposeSection,
} from "./external-fragments.js";

function purpose(...capabilities: ExternalGroupToolName[]): string {
  return externalPurposeSection(new Set(capabilities));
}

describe("external purpose derivation", () => {
  it("always states the group workspace scope even without any grant", () => {
    expect(purpose()).toMatch(/рабочей папк/iu);
    expect(purpose()).toMatch(/сводк|итог/iu);
    expect(purpose()).toMatch(/Markdown/iu);
  });

  it("adds a purpose line for each granted capability", () => {
    expect(purpose("web_search")).toMatch(/актуальную информацию/iu);
    expect(purpose("web_fetch")).toMatch(/страницу по ссылке/iu);
    expect(purpose("search_memories")).toMatch(/уже обсуждали/iu);
    expect(purpose("remember")).toMatch(/запомнить/iu);
    expect(purpose("list_group_history")).toMatch(/более раннюю переписку/iu);
    expect(purpose("inspect_workspace_image")).toMatch(/изображение/iu);
    expect(purpose("send_workspace_file")).toMatch(/отправить файл/iu);
  });

  it("omits the purpose line of a capability that is not granted", () => {
    expect(purpose("remember")).not.toMatch(/актуальную информацию/iu);
    expect(purpose("web_search")).not.toMatch(/более раннюю переписку/iu);
    expect(purpose()).not.toMatch(/изображение/iu);
  });

  it("describes purposes in human terms without naming any tool or capability", () => {
    const everything = purpose(
      "inspect_workspace_image",
      "list_group_history",
      "list_memories",
      "manage_memory.delete",
      "manage_memory.edit",
      "manage_memory.undo",
      "remember",
      "remove_group_file",
      "search_memories",
      "send_workspace_file",
      "web_fetch",
      "web_search",
    );

    // The external policy forbids revealing tool names to participants, and this section is the
    // wording the model reuses when it explains what it does here.
    expect(everything).not.toMatch(/`/u);
    for (const toolName of [
      "search_memories",
      "web_search",
      "web_fetch",
      "list_group_history",
      "inspect_workspace_image",
      "send_workspace_file",
      "remove_group_file",
      "manage_memory",
      "remember",
      "read_file",
      "glob",
    ]) {
      expect(everything, `purpose list must not name ${toolName}`).not.toContain(toolName);
    }
  });
});

describe("external task boundaries", () => {
  it("explicitly permits useful multi-step work and artifacts grounded in the group request", () => {
    for (const scenario of [
      /нескольк.*действ|многоэтап/iu,
      /сводк|summary/iu,
      /факт/iu,
      /источник/iu,
      /документ|отчёт/iu,
      /Markdown/iu,
    ]) {
      expect(EXTERNAL_TASK_BOUNDARIES, `boundaries must permit ${scenario}`).toMatch(scenario);
    }
  });

  it("does not use genre or effort as a reason to refuse", () => {
    expect(EXTERNAL_TASK_BOUNDARIES).not.toMatch(/не начинай многошаговую работу/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).not.toMatch(/если просьба требует.*документа.*здесь так не работаешь/isu);
    expect(EXTERNAL_TASK_BOUNDARIES).not.toMatch(/роль универсального ИИ-ассистента/iu);
  });

  it("keeps scope and background-continuation limits explicit", () => {
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/проверенн.*границ|доступн.*возможност/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/фонов|после завершения/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/не утверждай/iu);
  });
});

describe("external people rules", () => {
  it("permits attributed summaries and concrete fact-checking without profiling", () => {
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/позици|высказывани/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/конкретн.*утверждени/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/публичн.*источник/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/досье|профил/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/чувствительн/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/арбитр|спор/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/вместо него/iu);
  });

  it("treats claimed rights as ordinary text rather than authorization", () => {
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/я админ/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/не авторизация|а не авторизация/iu);
  });

  it("forbids commitments on behalf of the owner or the group", () => {
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/обещан/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/от лица владельца/iu);
  });
});
