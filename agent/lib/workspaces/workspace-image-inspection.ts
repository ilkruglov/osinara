/**
 * Authorized workspace and ephemeral Telegram vision boundary.
 *
 * Exports:
 * - `createWorkspaceImageInspector`: validates and submits authorized image bytes.
 * - `inspectWorkspaceImage`: production server-configured protocol-native vision inspector.
 */
import { generateText } from "ai";

import { visionModel } from "../model-registry.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { AppError, isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import {
  createWorkspaceImageReader,
  unsuitableImageSource,
  workspaceImageReaderDependencies,
  type WorkspaceImageLocation,
  type WorkspaceImageReaderDependencies,
} from "./workspace-image-source.js";
import type { WorkspaceAuthorization } from "./workspace-repository.js";

interface ImageAnalysisInput {
  abortSignal?: AbortSignal;
  bytes: Uint8Array;
  mediaType: string;
  question: string;
}

interface WorkspaceImageInspectorDependencies extends WorkspaceImageReaderDependencies {
  analyze(input: ImageAnalysisInput): Promise<string>;
  supportsImageInput: boolean;
}

async function analyzeImage(
  dependencies: WorkspaceImageInspectorDependencies,
  input: ImageAnalysisInput,
): Promise<string> {
  try {
    return await dependencies.analyze(input);
  } catch (error) {
    if (isAppError(error)) throw error;
    console.error(
      JSON.stringify({
        code: "AGENT_WORKSPACE_VISION_PROVIDER_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ModelFacingError({
      category: "dependency",
      code: "AGENT_WORKSPACE_VISION_PROVIDER_FAILED",
      correction:
        "Не повторяйте анализ автоматически. Сообщите, что анализ изображения временно недоступен.",
      reason: "Vision-модель завершила анализ с внутренней ошибкой.",
      retryable: false,
      sideEffectStatus: "not_started",
    });
  }
}

/**
 * Reads the image to inspect. A file the reader refuses (over 10 MB, not a still image) is an input
 * the model corrects with another file; it reached the model as an operation of unknown outcome,
 * «do not retry» (repeat review, 23 November 2026).
 */
async function readSource(
  dependencies: WorkspaceImageInspectorDependencies,
  auth: WorkspaceAuthorization,
  input: WorkspaceImageLocation,
) {
  try {
    return await createWorkspaceImageReader(dependencies)(auth, input);
  } catch (error) {
    const refusal = unsuitableImageSource(error);
    if (refusal === null) throw error;
    throw new ModelFacingError({
      category: "input",
      code: refusal.code,
      correction:
        "Возьми другой файл: статическое изображение JPEG, PNG или WebP не больше 10 МБ; или опиши задачу текстом.",
      field:
        "path" in input ? "path" : "attachmentId" in input ? "attachmentId" : "telegramMessageId",
      reason: refusal.reason,
      retryable: true,
      sideEffectStatus: "not_started",
    });
  }
}

export function createWorkspaceImageInspector(dependencies: WorkspaceImageInspectorDependencies) {
  return async (
    auth: WorkspaceAuthorization,
    input: {
      abortSignal?: AbortSignal;
      question: string;
    } & WorkspaceImageLocation,
  ) => {
    if (!dependencies.supportsImageInput) {
      await dependencies.authorizeScope(auth, input.scope);
      return {
        code: "AGENT_MODEL_IMAGE_INPUT_UNSUPPORTED",
        message:
          "Подключённая модель не поддерживает анализ изображений. Опишите содержимое изображения текстом",
        supported: false as const,
      };
    }

    const { bytes, mediaType, ...location } = await readSource(dependencies, auth, input);
    const analysis = await analyzeImage(dependencies, {
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      bytes,
      mediaType,
      question: input.question,
    });
    if (!analysis.trim()) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_RESPONSE_EMPTY",
        "Vision-модель не смогла описать изображение. Уточните вопрос и попробуйте снова",
      );
    }
    return { analysis, ...location };
  };
}

export const inspectWorkspaceImage = createWorkspaceImageInspector({
  async analyze(input) {
    if (visionModel === null) {
      throw new AppError(
        "AGENT_MODEL_VISION_CONFIG_INCONSISTENT",
        "Конфигурация vision-модели не соответствует заявленной поддержке изображений",
      );
    }
    const result = await generateText({
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      messages: [
        {
          content: [
            { text: input.question, type: "text" },
            { data: input.bytes, mediaType: input.mediaType, type: "file" },
          ],
          role: "user",
        },
      ],
      maxRetries: 0,
      model: visionModel,
    });
    return result.text;
  },
  ...workspaceImageReaderDependencies,
  supportsImageInput: modelProviderConfig.agent.models.vision.supportsImageInput,
});
