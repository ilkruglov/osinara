/**
 * Model-facing subscription image generation tool tests.
 *
 * Constructs covered:
 * - One successful generation is persisted in the workspace and never sent by itself.
 * - Completed and filesystem-recoverable calls never charge the subscription twice.
 * - Definitive and ambiguous provider outcomes become terminal durable operation states.
 * - The provider gate is asserted separately, so this suite runs the Codex-subscription runtime.
 */
import { createHash } from "node:crypto";

import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

vi.mock("./image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { AppError } from "./app-error.js";
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
    readImage: vi.fn().mockResolvedValue({ bytes: Buffer.from("original"), mediaType: "image/png" }),
    client: {
      assertConfigured: vi.fn(),
      assertSupportsEditing: vi.fn(),
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
      markAmbiguous: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    },
    workspaces: {
      findBinaryWrite: vi.fn().mockResolvedValue(null),
      workspaceId: vi.fn().mockResolvedValue("workspace-1"),
      writeBinary: vi.fn().mockImplementation(async (
        _auth: unknown,
        input: { path: string; scope: "family" | "group" | "personal" },
      ) => ({
        ...FILE,
        path: input.path,
        scope: input.scope,
      })),
    },
  };
}

describe("generate_image", () => {
  it.each(["AGENT_IMAGE_EDITING_INPUT_INVALID", "AGENT_IMAGE_EDITING_UNAVAILABLE"])("records %s as a definite failure", async (code) => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(new AppError(code, "Редактирование не началось"));
    await expect(createGenerateImageTool(deps as never).execute({ ...INPUT,
      images: [{ path: "photo.png", scope: "group" }],
    }, context())).rejects.toMatchObject({ code });
    expect(deps.operations.markFailed).toHaveBeenCalledWith("call-image-1", code);
    expect(deps.operations.markAmbiguous).not.toHaveBeenCalled();
  });

  it("returns a completed edit without calling the provider again", async () => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue({ file: FILE, state: "completed" });
    await expect(createGenerateImageTool(deps as never).execute({ ...INPUT,
      images: [{ telegramMessageId: "42", scope: "group" }],
    }, context())).resolves.toMatchObject({ generated: false, path: FILE.path });
    expect(deps.readImage).toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });

  it("rejects unavailable editing before reading a source or creating a reservation", async () => {
    const deps = dependencies();
    deps.client.assertSupportsEditing.mockImplementation(() => { throw new AppError("AGENT_IMAGE_EDITING_UNAVAILABLE", "Недоступно"); });
    await expect(createGenerateImageTool(deps as never).execute({ ...INPUT,
      images: [{ path: "photo.png", scope: "group" }],
    }, context())).rejects.toMatchObject({ code: "AGENT_IMAGE_EDITING_UNAVAILABLE" });
    expect(deps.readImage).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });
  it("reads an authorized source, hashes its bytes and saves the edit to a new path", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);
    const images = [{ path: "photos/source.png", scope: "group" }];
    await tool.execute({ ...INPUT, images }, context());
    expect(deps.readImage).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group-1" }), images[0]);
    expect(deps.client.generate).toHaveBeenCalledWith(expect.objectContaining({
      referenceImages: [{ bytes: Buffer.from("original"), mediaType: "image/png" }],
    }));
    expect(deps.workspaces.writeBinary.mock.calls[0]![1].path).toBe(GENERATED_PATH);
    const originalHash = deps.operations.begin.mock.calls[0]![0].inputHash;
    deps.readImage.mockResolvedValue({ bytes: Buffer.from("changed"), mediaType: "image/png" });
    await tool.execute({ ...INPUT, images }, context());
    expect(deps.operations.begin.mock.calls[1]![0].inputHash).not.toBe(originalHash);
  });

  it("stops before reservation and provider access when source authorization fails", async () => {
    const deps = dependencies();
    deps.readImage.mockRejectedValue(new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Нет доступа"));
    await expect(createGenerateImageTool(deps as never).execute({ ...INPUT,
      images: [{ path: "photo.png", scope: "personal" }],
    }, context())).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_DENIED" });
    expect(deps.operations.begin).not.toHaveBeenCalled();
    expect(deps.client.generate).not.toHaveBeenCalled();
  });

  it.each([[], [{ scope: "group" }], [{ scope: "group", path: "a.png", telegramMessageId: "42" }],
    Array.from({ length: 5 }, () => ({ scope: "group", path: "a.png" }))].map((images) => ({ images })))("rejects invalid edit sources $images", async ({ images }) => {
    const deps = dependencies();
    await expect(createGenerateImageTool(deps as never).execute({ ...INPUT, images }, context()))
      .rejects.toMatchObject({ code: "AGENT_IMAGE_GENERATION_INPUT_INVALID" });
    expect(deps.readImage).not.toHaveBeenCalled();
    expect(deps.operations.begin).not.toHaveBeenCalled();
  });
  it("rejects a model-supplied workspace scope", async () => {
    const deps = dependencies();
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute({ ...INPUT, scope: "personal" }, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_INPUT_INVALID/u);
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

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_CONFIG_INVALID/u);
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

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_REPLAY_MISMATCH/u);
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

  it("records a rejected prompt as a definitive failure", async () => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(new AppError(
      "AGENT_IMAGE_GENERATION_REJECTED",
      "Сервис генерации изображений отклонил запрос. Измените описание и попробуйте снова",
    ));
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(/AGENT_IMAGE_GENERATION_REJECTED/u);
    expect(deps.operations.markFailed).toHaveBeenCalledWith(
      "call-image-1",
      "AGENT_IMAGE_GENERATION_REJECTED",
    );
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });

  it("records uncertain provider completion as ambiguous without retrying", async () => {
    const deps = dependencies();
    deps.client.generate.mockRejectedValue(new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить результат генерации. Создайте новый запрос позднее",
    ));
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
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

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
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

    await expect(tool.execute(INPUT, context()))
      .rejects.toThrowError(/AGENT_IMAGE_GENERATION_STATUS_UNKNOWN/u);
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

  it.each([
    { errorCode: "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN", state: "ambiguous" as const },
    { errorCode: "AGENT_IMAGE_GENERATION_REJECTED", state: "failed" as const },
  ])("does not regenerate a terminal $state reservation", async (reservation) => {
    const deps = dependencies();
    deps.operations.begin.mockResolvedValue(reservation);
    const tool = createGenerateImageTool(deps as never);

    await expect(tool.execute(INPUT, context())).rejects.toThrowError(
      new RegExp(reservation.errorCode, "u"),
    );
    expect(deps.client.generate).not.toHaveBeenCalled();
    expect(deps.workspaces.writeBinary).not.toHaveBeenCalled();
  });
});
