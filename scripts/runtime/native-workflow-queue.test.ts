/** Validate the installed handler seam without starting a worker, HTTP server or application. */
import { describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { createQueue } from "../../node_modules/@workflow/world-postgres/dist/queue.js";

describe("installed Workflow queue execution fence", () => {
  it("joins a repeated live HTTP delivery instead of starting another execution", async () => {
    const pool = { options: {}, query: vi.fn() };
    const queue = createQueue({ pool: pool as never }, pool as never);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return { timeoutSeconds: 1 }; });
    const handler = queue.createQueueHandler("__wkf_workflow_", execute);
    const id = `msg_${ulid()}`, run = `wrun_${ulid()}`;
    const request = (attempt: number) => new Request("http://queue.invalid/flow", { method: "POST",
      headers: { "content-type": "application/json", "x-vqs-queue-name": "__wkf_workflow_test", "x-vqs-message-id": id, "x-vqs-message-attempt": String(attempt) },
      body: JSON.stringify({ runId: run }),
    });
    try {
      const first = handler(request(1)), repeat = handler(request(2));
      await vi.waitFor(() => expect(execute).toHaveBeenCalled()); release();
      const responses = await Promise.all([first, repeat]);
      expect(execute).toHaveBeenCalledOnce();
      expect(await Promise.all(responses.map(response => response.json()))).toEqual([{ timeoutSeconds: 1 }, { timeoutSeconds: 1 }]);
      expect(pool.query).not.toHaveBeenCalled();
    } finally { release(); await queue.close(); }
  });
});
