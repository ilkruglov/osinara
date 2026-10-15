/**
 * Jev client tests.
 *
 * Constructs covered:
 * - One `POST /v1/systemone` per decision with the pinned model and bearer auth; choice, score and
 *   noul answers come back under the caller's keys with latency and usage.
 * - Network failure, timeout, 429, 529 and 5xx are `AGENT_JEV_UNAVAILABLE`; another 4xx is
 *   `AGENT_JEV_REQUEST_REJECTED`; a non-JSON body, a malformed answer or a missing key is
 *   `AGENT_JEV_RESPONSE_INVALID`.
 */
import { describe, expect, it, vi } from "vitest";

import { createJevClient, JEV_MODEL } from "./jev-client.js";

const QUESTIONS = {
  escalates: { type: "noul" as const, instructions: "Ответ подхватывает эскалацию" },
  register: { type: "choice" as const, instructions: "Что это за ответ", criteria: { answer: "по делу", retort: "отповедь" } },
  worth: { type: "score" as const, instructions: "Стоит ли отправлять", criteria: ["нет", "да"] },
};
const OK = {
  answers: {
    escalates: { type: "noul", noul: 0.12 },
    register: { type: "choice", choice: "answer", confidence: 0.9, probabilities: { answer: 0.95, retort: 0.05 } },
    worth: { type: "score", score: 0.8, confidence: 0.6, legend: { "0": "нет", "1": "да" }, probabilities: { "0": 0.2, "1": 0.8 } },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 410, output_tokens: 30 },
};
const respond = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("createJevClient", () => {
  it("sends one systemone request and maps the typed answers", async () => {
    const fetchMock = vi.fn(respond(OK));
    const client = createJevClient({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const decision = await client.decide({ chat: "x" }, QUESTIONS);

    expect(decision.answers.register).toMatchObject({ choice: "answer", confidence: 0.9 });
    expect(decision.answers.worth).toMatchObject({ score: 0.8 });
    expect(decision.answers.escalates).toEqual({ type: "noul", noul: 0.12 });
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.usage).toEqual({ inputTokens: 410, outputTokens: 30 });
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toMatchObject({ authorization: "Bearer k" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ model: JEV_MODEL, questions: QUESTIONS, state: { chat: "x" } });
  });

  it("reports the vendor as unavailable on network errors, timeouts, 429, 529 and 5xx after one retry", async () => {
    const failing = vi.fn(async () => { throw new Error("ECONNRESET"); });
    await expect(createJevClient({ apiKey: "k", fetch: failing as unknown as typeof fetch, retryDelayMs: 0 }).decide({}, QUESTIONS))
      .rejects.toMatchObject({ code: "AGENT_JEV_UNAVAILABLE" });
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = createJevClient({
      apiKey: "k",
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
      retryDelayMs: 0,
      timeoutMs: 5,
    });
    await expect(slow.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_UNAVAILABLE" });
    for (const status of [429, 500, 529]) {
      const client = createJevClient({ apiKey: "k", fetch: respond("busy", status), retryDelayMs: 0 });
      await expect(client.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_UNAVAILABLE", status });
    }
  });

  it("recovers when the retry succeeds and treats a broken body stream as unavailable", async () => {
    const flaky = vi.fn().mockResolvedValueOnce(new Response("overloaded", { status: 529 })).mockResolvedValueOnce(new Response(JSON.stringify(OK), { status: 200 }));
    const decision = await createJevClient({ apiKey: "k", fetch: flaky as unknown as typeof fetch, retryDelayMs: 0 }).decide({}, QUESTIONS);
    expect(decision.model).toBe("jev-1.13.0");
    expect(flaky).toHaveBeenCalledTimes(2);
    const broken = new ReadableStream({ start(controller) { controller.error(new Error("aborted")); } });
    const client = createJevClient({ apiKey: "k", fetch: (async () => new Response(broken, { status: 200 })) as unknown as typeof fetch, retryDelayMs: 0 });
    await expect(client.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_UNAVAILABLE" });
  });

  it("rejects our own bad request and an invalid response without retry hints", async () => {
    const rejected = createJevClient({ apiKey: "k", fetch: respond({ error: "bad" }, 422) });
    await expect(rejected.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_REQUEST_REJECTED", status: 422 });
    const notJson = createJevClient({ apiKey: "k", fetch: respond("<html>") });
    await expect(notJson.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_RESPONSE_INVALID" });
    const missing = createJevClient({ apiKey: "k", fetch: respond({ ...OK, answers: { register: OK.answers.register } }) });
    await expect(missing.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_RESPONSE_INVALID" });
    const malformed = createJevClient({ apiKey: "k", fetch: respond({ ...OK, answers: { ...OK.answers, escalates: { type: "noul", noul: "high" } } }) });
    await expect(malformed.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_RESPONSE_INVALID" });
  });
});
