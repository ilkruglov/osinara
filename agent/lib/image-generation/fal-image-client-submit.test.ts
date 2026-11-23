/**
 * The fal.ai client's submit, with fal's queue played by a stub `fetch`.
 *
 * Constructs covered:
 * - One submit per call: a gateway error, a broken connection, a body that breaks off or a redirect
 *   on submit ends as an unknown outcome after exactly one POST (`fetch` itself would send it again
 *   on a redirect); a rate limit or a connection that never opened is an outage: on any address
 *   of the host, or by any certificate code of Node's tls docs.
 * - A job named by its `x-fal-request-id` header survives a submit answer that broke off or names
 *   no request id of the form of one.
 * - A submit fal refused is definite: a missing model is an outage, a too big body the source;
 *   its codes are read past a byte order mark, from a `detail` of any length (the first 32
 *   entries), and from fal's `X-Fal-Error-Type` header when the body names none.
 * - Any request id fal hands out is kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  brokenAnswer,
  dropped,
  droppedEveryAddress,
  falClient as client,
  falQueue,
  IMAGE_REQUEST as request,
  json,
  OUTAGE,
  rawFalQueue,
  REQUEST_ID,
  UNKNOWN,
} from "./fal-queue.test-fixtures.js";

describe("fal image client submit", () => {
  beforeEach(() => {
    for (const method of ["error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["a gateway error", () => json({ detail: "bad gateway" }, 502), UNKNOWN],
    ["a broken connection", dropped("ECONNRESET"), UNKNOWN],
    ["a refused connection", dropped("ECONNREFUSED"), OUTAGE],
    ["an unknown host", dropped("ENOTFOUND"), OUTAGE],
    ["an expired certificate", dropped("CERT_HAS_EXPIRED"), OUTAGE],
    ["a certificate not yet valid", dropped("CERT_NOT_YET_VALID"), OUTAGE],
    ["a connect timeout", dropped("ETIMEDOUT", "connect"), OUTAGE],
    // Happy Eyeballs: the host's addresses failed one by one, and none took the request.
    [
      "every address timing out or refusing",
      droppedEveryAddress("ETIMEDOUT", [
        ["ETIMEDOUT", "connect"],
        ["ECONNREFUSED", "connect"],
      ]),
      OUTAGE,
    ],
    [
      "addresses of which one may have taken the request",
      droppedEveryAddress("ETIMEDOUT", [["ETIMEDOUT", "connect"], ["ECONNRESET"]]),
      UNKNOWN,
    ],
    ["an aggregate naming no address", droppedEveryAddress("ETIMEDOUT", []), UNKNOWN],
    // The gateway gave up on a client that may already have queued the job.
    ["a client disconnect", () => json({ detail: "Client disconnected" }, 499), UNKNOWN],
    ["a rate limit", () => json({ detail: "slow down" }, 429), OUTAGE],
    ["a missing model", () => json({ detail: "Endpoint not found" }, 404), OUTAGE],
    [
      "a refused account",
      () => json({ detail: "Forbidden", type: "permission_denied" }, 403),
      OUTAGE,
    ],
    // The status alone decides: a refusal whose body is not JSON is still a refusal.
    [
      "a refused key with a broken body",
      () => new Response("{", { headers: { "content-type": "application/json" }, status: 401 }),
      OUTAGE,
    ],
  ])("sends one submit only after %s", async (_name, submit, outcome) => {
    const queue = falQueue({ submit });
    await expect(client(queue).generate(request)).rejects.toMatchObject(outcome);
    expect(queue.posts()).toHaveLength(1);
  });

  it("does not submit again when the answer to the submit breaks off mid-body", async () => {
    // A retry on the socket error, as for a poll, would order the picture again.
    const queue = falQueue({ submit: brokenAnswer(202) });
    await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
    expect(queue.posts()).toHaveLength(1);
  });

  it("follows a job whose submit answer broke off but whose header named it", async () => {
    const onProviderJob = vi.fn(async () => undefined);
    const queue = falQueue({ submit: brokenAnswer(202, { "x-fal-request-id": REQUEST_ID }) });
    await expect(client(queue).generate({ ...request, onProviderJob })).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(onProviderJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: REQUEST_ID }));
    expect(queue.posts()).toHaveLength(1);
  });

  it.each([
    ["no request id in a JSON answer", () => json({}, 202, { "x-fal-request-id": REQUEST_ID })],
    [
      "an empty 204",
      () => new Response(null, { headers: { "x-fal-request-id": REQUEST_ID }, status: 204 }),
    ],
    [
      "an empty request id in the body",
      () => json({ request_id: "" }, 202, { "x-fal-request-id": REQUEST_ID }),
    ],
    [
      "a request id in the body that is no id",
      () => json({ request_id: "../requests/other" }, 202, { "x-fal-request-id": REQUEST_ID }),
    ],
  ])("follows a job named only by its header after %s", async (_name, submit) => {
    const onProviderJob = vi.fn(async () => undefined);
    const queue = falQueue({ submit });
    await expect(client(queue).generate({ ...request, onProviderJob })).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(onProviderJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: REQUEST_ID }));
  });

  it("reads fal's codes from a refusal however long its echo of the input", async () => {
    // A 422 repeats the offending input: a source picture as a data URI is hundreds of kilobytes.
    const echo = `data:image/jpeg;base64,${"A".repeat(300_000)}`;
    const queue = falQueue({
      submit: () =>
        json(
          {
            detail: [
              { input: echo, loc: ["body", "image_urls", 0], msg: "x", type: "image_too_small" },
            ],
          },
          422,
        ),
    });
    await expect(client(queue).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
      contract: { field: "images" },
    });
  });

  it("reads fal's codes from a refusal however many entries its detail has", async () => {
    const error = vi.mocked(console.error);
    const detail = [
      { loc: ["body", "prompt"], msg: "x", type: "content_policy_violation" },
      ...Array.from({ length: 150_000 }, () => ({ loc: ["body"], msg: "x", type: "missing" })),
    ];
    const queue = falQueue({ submit: () => json({ detail }, 422) });
    await expect(client(queue).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
      contract: { correction: expect.stringContaining("брендов") },
    });
    // The log keeps a few codes, not one per entry.
    expect(JSON.stringify(error.mock.calls).length).toBeLessThan(10_000);
  });

  it("reads only the first 32 entries of a refusal's detail for its codes", async () => {
    const error = vi.mocked(console.error);
    const detail = Array.from({ length: 40 }, (_, index) => ({
      loc: ["body"],
      msg: "x",
      type: `code_${index}`,
    }));
    const queue = falQueue({ submit: () => json({ detail }, 422) });
    await expect(client(queue).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
    });
    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toContain("code_0,code_1,");
    expect(logged).toContain(',code_31"');
    expect(logged).not.toContain("code_32");
  });

  it("takes the code of a refused submit from fal's header when the body names none", async () => {
    const error = vi.mocked(console.error);
    const filtered = falQueue({
      submit: () =>
        json({ detail: "flagged" }, 422, { "x-fal-error-type": "content_policy_violation" }),
    });
    await expect(client(filtered).generate(request)).rejects.toMatchObject({
      contract: { correction: expect.stringContaining("брендов") },
    });
    // A body that broke off names nothing: the header still does.
    const blocked = falQueue({
      submit: brokenAnswer(403, { "x-fal-error-type": "permission_denied" }),
    });
    await expect(client(blocked).generate(request)).rejects.toMatchObject(OUTAGE);
    expect(error.mock.calls.flat().join("\n")).toContain("submit 403 permission_denied");
  });

  it("reads a submit answer that starts with a byte order mark, as `Response.json()` does", async () => {
    const withBom = (body: unknown, status: number) => () =>
      new Response(`\uFEFF${JSON.stringify(body)}`, {
        headers: { "content-type": "application/json" },
        status,
      });
    const onProviderJob = vi.fn(async () => undefined);
    const accepted = falQueue({ submit: withBom({ request_id: REQUEST_ID }, 202) });
    await expect(client(accepted).generate({ ...request, onProviderJob })).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    expect(onProviderJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: REQUEST_ID }));
    const filtered = falQueue({
      submit: withBom(
        { detail: [{ loc: ["body"], msg: "x", type: "content_policy_violation" }] },
        422,
      ),
    });
    await expect(client(filtered).generate(request)).rejects.toMatchObject({
      contract: { correction: expect.stringContaining("брендов") },
    });
  });

  // Node's tls docs, "X509 certificate error codes" (v24): each is raised while the handshake
  // verifies the certificate, before the request is written.
  it.each([
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_CRL",
    "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
    "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
    "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
    "CERT_SIGNATURE_FAILURE",
    "CRL_SIGNATURE_FAILURE",
    "CERT_NOT_YET_VALID",
    "CERT_HAS_EXPIRED",
    "CRL_NOT_YET_VALID",
    "CRL_HAS_EXPIRED",
    "ERROR_IN_CERT_NOT_BEFORE_FIELD",
    "ERROR_IN_CERT_NOT_AFTER_FIELD",
    "ERROR_IN_CRL_LAST_UPDATE_FIELD",
    "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
    "OUT_OF_MEM",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_CHAIN_TOO_LONG",
    "CERT_REVOKED",
    "INVALID_CA",
    "PATH_LENGTH_EXCEEDED",
    "INVALID_PURPOSE",
    "CERT_UNTRUSTED",
    "CERT_REJECTED",
    "HOSTNAME_MISMATCH",
  ])("takes a certificate refused with %s as an outage", async (code) => {
    const queue = falQueue({ submit: dropped(code) });
    await expect(client(queue).generate(request)).rejects.toMatchObject(OUTAGE);
    expect(queue.posts()).toHaveLength(1);
  });

  it("does not follow a redirect of the submit, which would send it a second time", async () => {
    const queue = await rawFalQueue((route) =>
      route === "submit" ? { headers: { location: "/moved" }, status: "307 Moved" } : undefined,
    );
    try {
      await expect(client(queue).generate(request)).rejects.toMatchObject(UNKNOWN);
      expect(queue.requests).toEqual(["POST /bytedance/seedream/v5.5/text-to-image"]);
    } finally {
      queue.close();
    }
  });

  it("takes a too big submit as the source's fault and logs fal's code of a refused account", async () => {
    const error = vi.mocked(console.error);
    const large = falQueue({ submit: () => json({ detail: "Request too large" }, 413) });
    await expect(client(large).generate(request)).rejects.toMatchObject({
      code: "AGENT_IMAGE_GENERATION_REJECTED",
      message: expect.stringContaining("исходник"),
    });
    const blocked = falQueue({
      submit: () => json({ detail: "Forbidden", type: "permission_denied" }, 403),
    });
    await expect(client(blocked).generate(request)).rejects.toMatchObject(OUTAGE);
    expect(error.mock.calls.flat().join("\n")).toContain("permission_denied");
  });

  it("keeps any request id fal hands out", async () => {
    const onProviderJob = vi.fn(async () => undefined);
    const queue = falQueue({
      submit: () => json({ request_id: "cmvbdeekj0073zx013f2euglr", status: "IN_QUEUE" }),
    });
    await client(queue).generate({ ...request, onProviderJob });
    expect(onProviderJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "cmvbdeekj0073zx013f2euglr" }),
    );
  });
});
