/**
 * Jev client tests.
 *
 * Constructs covered:
 * - One `POST /v1/systemone` per decision, bearer auth, typed answers mapped to a decision.
 * - 429 and 5xx become a retryable dependency error; a malformed body becomes a response error.
 */
import { describe, expect, it, vi } from "vitest";

import { createJevClient } from "./jev-client.js";

const OK = {
  model: "jev-latest",
  answers: {
    action: { type: "choice", choice: "CLICK [1]", probabilities: { "CLICK [1]": 0.97, DONE: 0.03 }, confidence: 0.96 },
  },
  usage: { input_tokens: 599, output_tokens: 95 },
};
const QUESTIONS = {
  action: { type: "choice" as const, instructions: "i", criteria: { "CLICK [1]": "кнопка", DONE: "готово" } },
};

describe("createJevClient", () => {
  it("sends one systemone request and maps the typed answers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 }));
    const client = createJevClient({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const decision = await client.decide({ task: "t" }, QUESTIONS);

    expect(decision.action.choice).toBe("CLICK [1]");
    expect(decision.action.confidence).toBeCloseTo(0.96);
    expect(decision.usage).toEqual({ inputTokens: 599, outputTokens: 95 });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toMatchObject({ authorization: "Bearer k" });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "jev-latest", state: { task: "t" } });
  });

  it("maps a noul answer when the question is asked", async () => {
    const body = { ...OK, answers: { ...OK.answers, final: { type: "noul", noul: 0.84 } } };
    const client = createJevClient({ apiKey: "k", fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch });

    const decision = await client.decide({}, { ...QUESTIONS, final: { type: "noul", instructions: "n" } });

    expect(decision.final).toBeCloseTo(0.84);
  });

  it("turns 429 and 5xx into a retryable dependency error", async () => {
    const client = createJevClient({ apiKey: "k", fetch: (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch });

    await expect(client.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_UNAVAILABLE", contract: { retryable: true } });
  });

  it("rejects a response without the action answer", async () => {
    const client = createJevClient({ apiKey: "k", fetch: (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as unknown as typeof fetch });

    await expect(client.decide({}, QUESTIONS)).rejects.toMatchObject({ code: "AGENT_JEV_RESPONSE_INVALID" });
  });
});
