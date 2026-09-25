/**
 * Look repository integration tests.
 *
 * Constructs covered:
 * - A look replaces the row and clears a pending click; typed data survives a new path of the same
 *   site and not a new origin.
 * - Typed data is one entry per field of a look; a pending click is claimed once; another member's
 *   look drops the typed data.
 * - Another family cannot read the row; reset deletes it.
 */
import { afterAll, describe, expect, it } from "vitest";

import { database } from "../database.js";
import { createLookRepository } from "./look-repository.js";
import { parsePageView, viewHash } from "./page-view.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (integrationTestsEnabled) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  if (!new URL(url).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const view = (epoch: string, url: string) => parsePageView(JSON.stringify({ elements: [{ n: 1, role: "button", text: "Продолжить" }], epoch, stateHash: 42, textHash: 7, title: "t", url }));

describeWithDatabase("lookRepository", () => {
  afterAll(async () => { await database().end(); });

  it("replaces the look, keeps typed data on the same site and clears it on a new origin", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Looks ${suffix}`]);
    const other = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Other ${suffix}`]);
    const users = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'One'), ($2, 'Two') RETURNING id",
      [`lk-${suffix}-1`, `lk-${suffix}-2`],
    );
    const [userId, otherUserId] = [users.rows[0]!.id, users.rows[1]!.id];
    const familyId = family.rows[0]!.id; const sandbox = `sbx-${suffix}`;
    const repo = createLookRepository();
    const save = (epoch: string, url: string, who = userId) => repo.saveLook({ familyId, sandboxSessionId: sandbox, screenshotPath: `shots/${epoch}.png`, userId: who, view: view(epoch, url), viewHash: viewHash(view(epoch, url)), vision: null });

    const first = await save("e1", "https://b.yclients.ru/company/1/personal/select-services?o=m-1");
    expect(first).toMatchObject({ entered: [], epoch: "e1", pending: null, stateHash: 42, steps: 0, textHash: 7 });
    await repo.addEntered(sandbox, familyId, { epoch: "e1", field: "text", label: "Телефон", n: 1, value: "+7916" });
    await repo.addEntered(sandbox, familyId, { epoch: "e1", field: "phone", label: "Телефон", n: 1, value: "+79160000000" });
    await repo.setPending(sandbox, familyId, { element: first.elements[0]!, epoch: "e1", n: 1, reason: "form-submit" });
    expect((await repo.get(sandbox, familyId))!.pending).toMatchObject({ n: 1 });
    expect(await repo.claimPending(sandbox, familyId, "e1", 2)).toBe(false);
    expect(await repo.claimPending(sandbox, familyId, "e1", 1)).toBe(true);
    expect(await repo.claimPending(sandbox, familyId, "e1", 1)).toBe(false);
    expect((await repo.get(sandbox, familyId))!.pending).toMatchObject({ claimed: true, n: 1 });

    const sameChain = await save("e2", "https://b.yclients.ru/company/1/personal/select-services?o=m-1s5");
    expect(sameChain).toMatchObject({ entered: [{ epoch: "e1", field: "phone", label: "Телефон", n: 1, value: "+79160000000" }], epoch: "e2", pending: null, steps: 1 });
    // The same label in another look is another field: two guests' names both stay.
    await repo.addEntered(sandbox, familyId, { epoch: "e2", field: "name", label: "Имя", n: 1, value: "А" });
    await repo.addEntered(sandbox, familyId, { epoch: "e2", field: "name", label: "Имя", n: 2, value: "Б" });
    expect((await repo.get(sandbox, familyId))!.entered.map((e) => e.value)).toEqual(["+79160000000", "А", "Б"]);

    const newPath = await save("e3", "https://b.yclients.ru/company/1/personal/select-time?o=m-1s5");
    expect(newPath.entered).toHaveLength(3);
    // Another member's look on the same site starts fresh: nothing of the first one's data stays.
    const theirs = await save("e5", "https://b.yclients.ru/company/1/personal/select-time?o=m-1s5", otherUserId);
    expect(theirs).toMatchObject({ entered: [], userId: otherUserId });
    const newOrigin = await save("e4", "https://dikidi.net/ru/1");
    expect(newOrigin).toMatchObject({ entered: [], steps: 4 });

    expect(await repo.get(sandbox, other.rows[0]!.id)).toBeNull();
    await repo.reset(sandbox, familyId);
    expect(await repo.get(sandbox, familyId)).toBeNull();
  });
});
