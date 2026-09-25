/**
 * Look repository integration tests.
 *
 * Constructs covered:
 * - A look replaces the row and clears a pending click; typed data survives a query change of the
 *   same page and not a new path.
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

const view = (epoch: string, url: string) => parsePageView(JSON.stringify({ elements: [{ n: 1, role: "button", text: "Продолжить" }], epoch, title: "t", url }));

describeWithDatabase("lookRepository", () => {
  afterAll(async () => { await database().end(); });

  it("replaces the look, keeps typed data on the same page chain and clears it on a new path", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Looks ${suffix}`]);
    const other = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ($1) RETURNING id", [`Other ${suffix}`]);
    const familyId = family.rows[0]!.id; const sandbox = `sbx-${suffix}`;
    const repo = createLookRepository();
    const save = (epoch: string, url: string) => repo.saveLook({ familyId, sandboxSessionId: sandbox, screenshotPath: `shots/${epoch}.png`, view: view(epoch, url), viewHash: viewHash(view(epoch, url)), vision: null });

    const first = await save("e1", "https://b.yclients.ru/company/1/personal/select-services?o=m-1");
    expect(first).toMatchObject({ entered: [], epoch: "e1", pending: null, steps: 0 });
    await repo.addEntered(sandbox, familyId, { field: "phone", label: "Телефон", n: 1 });
    await repo.setPending(sandbox, familyId, { element: first.elements[0]!, epoch: "e1", n: 1, reason: "form-submit" });
    expect((await repo.get(sandbox, familyId))!.pending).toMatchObject({ n: 1 });

    const sameChain = await save("e2", "https://b.yclients.ru/company/1/personal/select-services?o=m-1s5");
    expect(sameChain).toMatchObject({ entered: [{ field: "phone", label: "Телефон", n: 1 }], epoch: "e2", pending: null, steps: 1 });

    const newPath = await save("e3", "https://b.yclients.ru/company/1/personal/select-time?o=m-1s5");
    expect(newPath).toMatchObject({ entered: [], steps: 2 });

    expect(await repo.get(sandbox, other.rows[0]!.id)).toBeNull();
    await repo.reset(sandbox, familyId);
    expect(await repo.get(sandbox, familyId)).toBeNull();
  });
});
