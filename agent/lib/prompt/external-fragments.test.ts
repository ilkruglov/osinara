/**
 * External-group task boundary tests.
 *
 * Constructs covered:
 * - The purpose list is derived from the effective allowlist, in human terms without tool names.
 * - Task boundaries, refusal form, and people rules are present regardless of granted capabilities.
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
    expect(purpose()).toMatch(/Всё, что не входит в этот список/u);
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
  it("caps the effort per request instead of listing forbidden topics", () => {
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/один ответ на обращение/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/многошаговую работу/iu);
  });

  it("names the abuse categories that a public chat attracts", () => {
    for (const category of [/учебное/iu, /перевод/iu, /код/u, /на заказ/iu, /универсальн/iu]) {
      expect(EXTERNAL_TASK_BOUNDARIES, `boundaries must cover ${category}`).toMatch(category);
    }
  });

  it("makes a refusal terminal and non-negotiable without explaining the policy", () => {
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/один раз/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/не объясняй/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/част(ями|ям)/iu);
    expect(EXTERNAL_TASK_BOUNDARIES).toMatch(/переформулир/iu);
  });
});

describe("external people rules", () => {
  it("blocks profiling, arbitration, and acting for another participant", () => {
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/характеристик/iu);
    expect(EXTERNAL_PEOPLE_RULES).toMatch(/третьего лица/iu);
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
