/**
 * Model-facing image generation tool tests.
 *
 * Constructs covered:
 * - One successful generation is persisted in the workspace and never sent by itself.
 * - Completed and filesystem-recoverable calls never charge the provider twice.
 * - Definitive and ambiguous provider outcomes become terminal durable operation states.
 * - The provider gate is asserted separately, so this suite runs with image generation available.
 */
import { createHash } from "node:crypto";

import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { AppError } from "./app-error.js";
import { createImagePromptSeries } from "./image-generation/image-prompt-series.js";
import { rejected, unavailable } from "./image-generation/image-provider.js";
import { ModelFacingError } from "./model-facing-error.js";
import { createGenerateImageTool } from "./tools/generate_image.js";

const GENERATED_PATH = `generated-images/image-${createHash("sha256")
  .update("call-image-1", "utf8")
  .digest("hex")
  .slice(0, 24)}.webp`;
const FILE = {
  byteSize: 12,
  contentSha256: "a".repeat(64),
  mediaType: "image/webp",
  path: GENERATED_PATH,
  scope: "group" as const,
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const INPUT = {
  background: "opaque" as const,
  prompt: "A clean editorial illustration of a shared calendar",
  quality: "high" as const,
  size: "1536x1024" as const,
};

function context(): ToolContext {
  return {
    callId: "call-image-1",
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            groupId: "group-1",
            groupType: "external",
            role: "external",
            telegramChatId: "-1001",
            telegramChatType: "supergroup",
          },
          authenticator: "telegram",
          principalId: "telegram:101",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-image",
      turn: { id: "turn-image", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies() {
  return {
    readImage: vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("original"), mediaType: "image/png" }),
    client: {
      assertConfigured: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        bytes: Buffer.from("generated"),
        mediaType: "image/webp",
        model: "gpt-image-2",
        revisedPrompt: "Revised prompt",
      }),
    },
    operations: {
      begin: vi.fn().mockResolvedValue({ state: "execute", workspaceId: "workspace-1" }),
      complete: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(false),
      markAmbiguous: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      recordProviderJob: vi.fn().mockResolvedValue(undefined),
    },
    series: createImagePromptSeries(),
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi
        .fn()
        .mockImplementation(
          async (
            _auth: unknown,
            input: { path: string; scope: "family" | "group" | "personal" },
          ) => ({
            ...FILE,
            path: input.path,
            scope: input.scope,
          }),
        ),
    },
  };
}

describe("generate_image", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["AGENT_IMAGE_EDITING_INPUT_INVALID", "AGENT_IMAGE_GENERATION_CONFIG_INVALID"])(
    "records %s as a definite failure",
    async (code) => {
      const deps = dependencies();
      deps.client.generate.mockRejectedValue(new AppError(code, "Редактирование не началось"));
      await expect(
        createGenerateImageTool(deps as never).execute(
          { ...INPUT, images: [{ path: "photo.png", scope: "group" }] },
          context(),
        ),
      ).rejects.toMatchObject({ code });
      expect(deps.operations.markFailed).toHaveBeenCalledWith("call-image-1", code);
      expect(deps.operations.markAmbiguous).not.toHaveBeenCalled();
    },
  );

  it("records the provider job in the ledger and still delivers when the record fails", async () => {
    const deps = dependencies();
    const job = {
      jobId: "01a202d3-0b06-7d63-bcdc-2e758507e698",
      model: "bytedance/seedream/v5.5/text-to-image",
      provider: "fal",
    };
    deps.operations.recordProviderJob.mockRejectedValueOnce(new Error("ledger down"));
    deps.client.generate.mockImplementation(
      async (input: { onProviderJob?: (job: unknown) => Promise<void> }) => {
        await input.onProviderJob?.(job);
        return {
          bytes: Buffer.from("generated"),
          mediaType: "image/jpeg",
          model: "fal/bytedance/seedream/v5.5/text-to-image",
        };
      },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      createGenerateImageTool(deps as never).execute(INPUT, context()),
    ).resolves.toMatchObject({ generated: true });
    expect(deps.operations.recordProviderJob).toHaveBeenCalledWith("call-image-1", job);
    expect(error.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "AGENT_IMAGE_GENERATION_JOB_RECORD_FAILED",
    );
    error.mockRestore();
  });

  it("returns a completed edit without calling the provider again", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    await expect(
      createGenerateImageTool(deps as never).execute(
        { ...INPUT, images: [{ telegramMessageId: "42", scope: "group" }] },
        context(),
      ),
    ).resolves.toMatchObject({ generated: false, path: FILE.path });
    expect(deps.readImage).toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured service before reading a source or creating a reservation", async () => {
    const deps = dependencies();
    deps.client.assertConfigured.mockImplementation(() => {
      throw new AppError("AGENT_IMAGE_GENERATION_CONFIG_INVALID", "Недоступно");
    });
    await expect(
      createGenerateImageTool(deps as never).execute(
        { ...INPUT, images: [{ path: "photo.png", scope: "group" }] },
        context(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_CONFIG_INVALID" });
    expect(deps.readImage).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });
  it("reads an authorized source, hashes its bytes and saves the edit to a new path", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);
    const images = [{ path: "photos/source.png", scope: "group" }];
    await tool.execute({ ...INPUT, images }, context());
    expect(deps.readImage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "group-1" }),
      images[0],
    );
    expect(deps.client.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [{ bytes: Buffer.from("original"), mediaType: "image/png" }],
      }),
    );
    expect(deps.workspaces.writeBinary.mock.calls[0]![1].path).toBe(GENERATED_PATH);
    const originalHash = deps.operations.begin.mock.calls[0]![0].inputHash;
    deps.readImage.mockResolvedValue({ bytes: Buffer.from("changed"), mediaType: "image/png" });
    await tool.execute({ ...INPUT, images }, context());
    expect(deps.operations.begin.mock.calls[1]![0].inputHash).not.toBe(originalHash);
  });

  it("stops before reservation and provider access when source authorization fails", async () => {
    const deps = dependencies();
    deps.readImage.mockRejectedValue(new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Нет доступа"));
    await expect(
      createGenerateImageTool(deps as never).execute(
        { ...INPUT, images: [{ path: "photo.png", scope: "personal" }] },
        context(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_DENIED" });
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  // Repeat review, 23 November 2026: the workspace reader refuses a source over 10 MB or of a type it
  // cannot read before the provider sees it; the model got an operation of unknown outcome and gave
  // up instead of taking another source.
  it.each([
    ["AGENT_WORKSPACE_VISION_FILE_TOO_LARGE", "Изображение должно быть размером не более 10 МБ"],
    ["AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED", "Формат изображения не поддерживается"],
  ])("tells the model to take another source when the reader refuses %s", async (code, message) => {
    const deps = dependencies();
    deps.readImage
      .mockResolvedValueOnce({ bytes: Buffer.from("first"), mediaType: "image/png" })
      .mockRejectedValueOnce(new AppError(code, message));

    // Which of several sources to replace is part of the advice (repeat review, 23 November 2026).
    await expect(
      createGenerateImageTool(deps as never).execute(
        {
          ...INPUT,
          images: [
            { path: "first.png", scope: "personal" },
            { path: "photo.jpg", scope: "personal" },
          ],
        },
        context(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_IMAGE_EDITING_INPUT_INVALID",
      contract: {
        category: "input",
        field: "images[1]",
        reason: `Исходник 2: ${message}`,
        retryable: true,
        sideEffectStatus: "not_started",
      },
    });
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  // Repeat review, 23 November 2026: a replay of a call the ledger already holds, its source since
  // replaced by a file the reader refuses, was told to take another source; doing so under a new
  // call ordered a second paid picture. The replay answers as a refused read did before.
  it("does not advise another source on a replay of a recorded call", async () => {
    const deps = dependencies();
    deps.operations.exists.mockResolvedValue(true);
    deps.readImage.mockRejectedValue(
      new AppError(
        "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
        "Изображение должно быть не более 10 МБ",
      ),
    );
    const failure: unknown = await createGenerateImageTool(deps as never)
      .execute({ ...INPUT, images: [{ path: "edit.png", scope: "personal" }] }, context())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE" });
    expect(failure).not.toHaveProperty("contract.retryable", true);
    expect(deps.operations.exists).toHaveBeenCalledWith("call-image-1");
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      [{ scope: "group" }],
      [{ scope: "group", path: "a.png", telegramMessageId: "42" }],
      Array.from({ length: 5 }, () => ({ scope: "group", path: "a.png" })),
    ].map((images) => ({ images })),
  )("rejects invalid edit sources $images", async ({ images }) => {
    const deps = dependencies();
    await expect(
      createGenerateImageTool(deps as never).execute({ ...INPUT, images }, context()),
    ).rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_INPUT_INVALID" });
    expect(deps.readImage).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });
  it("rejects a model-supplied workspace scope", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute({ ...INPUT, scope: "personal" }, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_INPUT_INVALID/u,
    );
    expect(deps.workspaces.workspaceId).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });

  it("validates provider configuration before reserving an operation", async () => {
    const deps = dependencies();
    deps.client.assertConfigured.mockImplementation(() => {
      throw new AppError(
        "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
        "Не настроен доступ к сервису генерации изображений",
      );
    });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_CONFIG_INVALID/u,
    );
    expect(deps.workspaces.workspaceId).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });

  it("generates and stores one authorized image without sending it", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      delivered: false,
      generated: true,
      model: "gpt-image-2",
      path: expect.stringMatching(/^generated-images\/image-[0-9a-f]{24}\.webp$/u),
      revisedPrompt: "Revised prompt",
      scope: "group",
      sent: false,
    });
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.workspaces.writeBinary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bytes: Buffer.from("generated"),
        mediaType: "image/webp",
        operationKey: "call-image-1",
        scope: "group",
      }),
    );
    expect(deps.operations.complete).toHaveBeenCalledWith(
      "call-image-1",
      expect.objectContaining({
        path: expect.stringMatching(/^generated-images\/image-[0-9a-f]{24}\.webp$/u),
        scope: "group",
      }),
    );
  });

  it("returns a completed replay without generating or writing again", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });

  it("rejects completed metadata that does not match the reserved output", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({
      file: { ...FILE, scope: "personal" },
      state: "completed",
    });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_REPLAY_MISMATCH/u,
    );
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  it("recovers a written file after a crash before ledger completion", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ state: "started", workspaceId: "workspace-1" });
    deps.workspaces.findBinaryWrite.mockResolvedValue(FILE);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.operations.complete).toHaveBeenCalledWith("call-image-1", FILE);
  });

  it.each([
    ["a refusal", () => rejected("fal", "422 content_policy_violation", "content"), "input"],
    ["an outage", () => unavailable("fal", "submit 403"), "dependency"],
  ])(
    "records %s from the provider as failed and hands the model its contract",
    async (_name, failure, category) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const deps = dependencies();
      const error = failure();
      deps.client.generate.mockRejectedValue(error);
      const tool = createGenerateImageTool(deps as never);

      const thrown: unknown = await tool
        .execute(INPUT, context())
        .catch((caught: unknown) => caught);
      expect(thrown).toBeInstanceOf(ModelFacingError);
      expect(thrown).toMatchObject({
        contract: { category, code: error.code, sideEffectStatus: "not_started" },
      });
      expect(deps.operations.markFailed).toHaveBeenCalledWith("call-image-1", error.code);
      expect(deps.operations.markAmbiguous).not.toHaveBeenCalled();
      expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
    },
  );

  it("records uncertain provider completion as ambiguous without retrying", async () => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(
      new AppError(
        "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
        "Не удалось подтвердить результат генерации. Создайте новый запрос позднее",
      ),
    );
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u,
    );
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );
  });

  it("marks a failed workspace write ambiguous after provider completion", async () => {
    const deps = dependencies();
    deps.workspaces.writeBinary.mockRejectedValue(new Error("disk unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u,
    );
    expect(deps.operations.markAmbiguous).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    );
    consoleError.mockRestore();
  });

  it("recovers a written image when only ledger completion failed", async () => {
    const deps = dependencies();
    deps.operations.complete.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      /AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u,
    );
    expect(deps.operations.markAmbiguous).not.toHaveBeenCalled();

    deps.operations.begin.mockResolvedValue({ state: "started", workspaceId: "workspace-1" });
    deps.workspaces.findBinaryWrite.mockResolvedValue(FILE);
    await expect(tool.execute(INPUT, context())).resolves.toMatchObject({
      generated: false,
      path: FILE.path,
    });
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.operations.complete).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("does not regenerate an ambiguous reservation, which may have been billed", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({
      errorCode: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      state: "ambiguous",
    });
    const tool = createGenerateImageTool(deps as never);

    const thrown: unknown = await tool.execute(INPUT, context()).catch((caught: unknown) => caught);
    expect(thrown).toMatchObject({ code: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN" });
    expect(thrown).not.toBeInstanceOf(ModelFacingError);
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  // A failed call made nothing, replayed or not; a refusal stays correctable once, as it was.
  it.each([
    ["AGENT_IMAGE_GENERATION_REJECTED", { category: "input", retryable: true }],
    ["AGENT_IMAGE_EDITING_INPUT_INVALID", { category: "input", retryable: true }],
    ["AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE", { category: "operation", retryable: false }],
  ])("does not regenerate a failed %s reservation", async (errorCode, contract) => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ errorCode, state: "failed" });
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toMatchObject({
      code: errorCode,
      contract: { ...contract, sideEffectStatus: "not_started" },
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });

  const ROBOT =
    "Вертикальный кадр, стиль ретро-плаката 1950-х, пожелтевшая бумага. Сцена: ретро-робот с ламповыми глазами держит катушку магнитной ленты, за спиной три серверные стойки.";
  const ECHO =
    "Обложка журнала в стиле барокко. Центр: ретро-робот с ламповыми глазами на шестерне, в руке катушка магнитной ленты, за спиной три серверные стойки.";

  it("refuses a new picture that echoes the series before anything is reserved, and names the repeats", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);
    await expect(tool.execute({ ...INPUT, prompt: ROBOT }, context())).resolves.toMatchObject({
      generated: true,
    });
    expect(deps.series.previous("wrun-image")).toEqual([ROBOT]);

    const refusal = await tool
      .execute({ ...INPUT, prompt: ECHO }, { ...context(), callId: "call-image-2" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ModelFacingError);
    expect((refusal as ModelFacingError).contract).toMatchObject({
      category: "input",
      code: "AGENT_IMAGE_PROMPT_REPEATS_SERIES",
      field: "prompt",
      retryable: true,
      sideEffectStatus: "not_started",
      reason: expect.stringContaining("ламповыми глазами"),
      correction: expect.stringContaining("keep"),
    });
    // The ledger knows the refusal as a definite failure of that call; the provider was not asked.
    expect(deps.operations.markFailed).toHaveBeenCalledWith(
      "call-image-2",
      "AGENT_IMAGE_PROMPT_REPEATS_SERIES",
    );
    expect(deps.client.generate).toHaveBeenCalledTimes(1);
    expect(deps.series.previous("wrun-image")).toEqual([ROBOT]);
  });

  it("replays a stored refusal as the same input correction", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({
      errorCode: "AGENT_IMAGE_PROMPT_REPEATS_SERIES",
      state: "failed",
    });
    const replayed = await createGenerateImageTool(deps as never)
      .execute({ ...INPUT, prompt: ECHO }, context())
      .catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(ModelFacingError);
    expect((replayed as ModelFacingError).contract).toMatchObject({
      category: "input",
      retryable: true,
      sideEffectStatus: "not_started",
    });
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  it("serves a replay of an earlier call without measuring it against its own prompt", async () => {
    const deps = dependencies();
    deps.series.remember("wrun-image", ROBOT);
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    await expect(
      createGenerateImageTool(deps as never).execute({ ...INPUT, prompt: ROBOT }, context()),
    ).resolves.toMatchObject({ generated: false, path: FILE.path });
    expect(deps.operations.markFailed).not.toHaveBeenCalled();
    expect(deps.series.previous("wrun-image")).toEqual([ROBOT]);
  });

  it("lets the declared keep through, remembers the picture, and exempts an edit", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);
    await tool.execute({ ...INPUT, prompt: ROBOT }, context());
    await expect(
      tool.execute(
        {
          ...INPUT,
          keep: [
            "сюжет: ретро-робот с ламповыми глазами, катушка магнитной ленты, три серверные стойки",
          ],
          prompt: ECHO,
        },
        { ...context(), callId: "call-image-2" },
      ),
    ).resolves.toMatchObject({ generated: true });
    expect(deps.series.previous("wrun-image")).toEqual([ROBOT, ECHO]);
    // The provider never sees the declaration.
    expect(deps.client.generate.mock.calls[1]![0]).not.toHaveProperty("keep");

    await expect(
      tool.execute(
        { ...INPUT, images: [{ path: "photo.png", scope: "group" }], prompt: ECHO },
        { ...context(), callId: "call-image-3" },
      ),
    ).resolves.toMatchObject({ generated: true });
    expect(deps.series.previous("wrun-image")).toEqual([ROBOT, ECHO]);
  });
});
