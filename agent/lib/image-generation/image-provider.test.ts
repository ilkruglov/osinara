/**
 * The image provider's shared support: references, the result body, the job report.
 *
 * Constructs covered:
 * - References are prepared as JPEG with orientation applied, metadata dropped and the longer side
 *   bounded to 1536; unsupported, corrupt or oversized input is refused before any request, with
 *   the advice to take another source on the first refusal.
 * - An inline picture (a data URI) is refused past its bound before decoding, and typed by its
 *   content (`file-type`); a picture of several frames is refused.
 * - An accepted job is reported to the caller's ledger without waiting for a slow one.
 */
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareUploadReference } from "./image-editing-input.js";
import {
  imageFromBytes,
  PROVIDER_JOB_RECORD_TIMEOUT_MS,
  imageFromDataUri,
  reportProviderJob,
} from "./image-provider.js";

import { IMAGE_REQUEST as request, JPEG } from "./fal-queue.test-fixtures.js";
/** A PNG signature over garbage: neither sharp nor `file-type` takes it for a picture. */
const BROKEN_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("image provider support", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prepares a reference as an upright JPEG without metadata, the longer side at most 1536", async () => {
    const rotated = await sharp({
      create: { background: "red", channels: 3, height: 50, width: 100 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const upright = await prepareUploadReference({ bytes: rotated, mediaType: "image/jpeg" }, 0);
    const metadata = await sharp(upright).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", height: 100, width: 50 });
    expect(metadata.exif).toBeUndefined();
    const wide = await sharp({
      create: { background: "blue", channels: 4, height: 1_000, width: 3_000 },
    })
      .png()
      .toBuffer();
    expect(
      await sharp(
        await prepareUploadReference({ bytes: wide, mediaType: "image/png" }, 0),
      ).metadata(),
    ).toMatchObject({ format: "jpeg", height: 512, width: 1_536 });
  });

  it.each([
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>"),
    BROKEN_PNG,
    Buffer.alloc(10 * 1024 * 1024 + 1),
  ])("refuses unsupported, corrupt or oversized input %#", async (bytes) => {
    // The first refusal already tells the model to take another source, as a replay of it does.
    await expect(
      prepareUploadReference({ bytes, mediaType: "image/png" }, 2),
    ).rejects.toMatchObject({
      code: "AGENT_IMAGE_EDITING_INPUT_INVALID",
      contract: {
        category: "input",
        correction: expect.stringContaining("другой исходник"),
        field: "images[2]",
        reason: expect.stringMatching(/^Исходник 3: /u),
        retryable: true,
        sideEffectStatus: "not_started",
      },
    });
  });

  it("decodes an inline picture and refuses one that is too big or not inline", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      imageFromDataUri(`data:image/jpeg;base64,${JPEG.toString("base64")}`, "fal/model", "fal"),
    ).resolves.toMatchObject({ mediaType: "image/jpeg" });
    const unknown = expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
    for (const uri of ["https://v3b.fal.media/files/result.jpg", "data:text/plain,hi"]) {
      await expect(imageFromDataUri(uri, "fal/model", "fal")).rejects.toThrow(unknown);
    }
    // One byte past 32 MiB, behind a JPEG signature: refused for its size, not for its content.
    const oneTooMany = Buffer.alloc(32 * 1024 * 1024 + 1);
    JPEG.copy(oneTooMany);
    const oversized = `data:image/jpeg;base64,${oneTooMany.toString("base64")}`;
    await expect(imageFromDataUri(oversized, "fal/model", "fal")).rejects.toThrow(unknown);
    expect(error.mock.calls.flat().join("\n")).toContain("image too large");
  });

  // 32 MiB and one byte more have the same base64 length: only a longer text reaches the first check.
  it("refuses base64 longer than 32 MiB encode before decoding it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const from = vi.spyOn(Buffer, "from");
    const tooLong = `data:image/jpeg;base64,${"A".repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4)}`;
    await expect(imageFromDataUri(tooLong, "fal/model", "fal")).rejects.toThrow(
      expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" }),
    );
    expect(from).not.toHaveBeenCalledWith(expect.anything(), "base64");
  });

  // sharp decodes the first frame only: the other frames of an animated picture go unchecked.
  it("refuses a picture of several frames", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frame = async (background: string) =>
      await sharp({ create: { background, channels: 3, height: 1, width: 1 } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame("red"), await frame("blue")], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(imageFromBytes(animated, "fal/model", "fal")).rejects.toThrow(
      expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" }),
    );
  });

  it("types a picture by its content and takes anything else as an unknown outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pixel = { background: "red", channels: 3 as const, height: 1, width: 1 };
    for (const [format, mediaType] of [
      ["png", "image/png"],
      ["webp", "image/webp"],
    ] as const) {
      const bytes = await sharp({ create: pixel }).toFormat(format).toBuffer();
      await expect(imageFromBytes(bytes, "fal/model", "fal")).resolves.toMatchObject({ mediaType });
    }
    await expect(imageFromBytes(JPEG, "fal/model", "fal")).resolves.toMatchObject({
      mediaType: "image/jpeg",
    });
    const unknown = expect.objectContaining({ code: "AGENT_IMAGE_GENERATION_AMBIGUOUS" });
    for (const bytes of [
      Buffer.from("hello"),
      // A JPEG cut off midway: its signature is right, its picture is not there.
      JPEG.subarray(0, JPEG.length - 40),
      // "RIFF....WEBP" with the high bit set on every letter is not WebP either.
      BROKEN_PNG,
      Buffer.from("d2c9c6c600000000d7c5c2d0", "hex"),
    ]) {
      await expect(imageFromBytes(bytes, "fal/model", "fal")).rejects.toThrow(unknown);
    }
  });

  it("reports an accepted job and does not wait for a slow ledger beyond its bound", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const job = { jobId: "job-1", model: "m", provider: "fal" };
    const onProviderJob = vi.fn(() => new Promise<void>(() => undefined));
    const reported = reportProviderJob({ ...request, onProviderJob }, job);
    await vi.advanceTimersByTimeAsync(PROVIDER_JOB_RECORD_TIMEOUT_MS);
    await reported;
    expect(onProviderJob).toHaveBeenCalledWith(job);
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "AGENT_IMAGE_GENERATION_JOB_RECORD_TIMEOUT",
    );
  });
});
