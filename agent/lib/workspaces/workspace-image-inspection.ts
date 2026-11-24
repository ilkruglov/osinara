/**
 * Authorized workspace and ephemeral Telegram vision boundary.
 *
 * Exports:
 * - `createWorkspaceImageInspector`: validates and submits authorized image bytes.
 * - `inspectWorkspaceImage`: production server-configured protocol-native vision inspector.
 * - `VISION_ANSWER_INSTRUCTIONS`, `analyzeWithVision`: what the vision model is told with a question.
 *
 * Key construct:
 * - Vision answers keep what is seen apart from what is guessed. On 22 November 2026, asked which
 *   meme a sweater came from, vision named two different memes as fact within a minute, and Mia
 *   answered with the second one as if it were seen; the core rule «не называй догадку фактом»
 *   cannot work when the tool hands over a guess as a fact. A caller whose question sets its own
 *   answer format (the browser asks for strict JSON) says so with `questionSetsFormat`.
 */
import { generateText, type LanguageModel } from "ai";

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
  /** The question prescribes the answer's format itself, so the sections are not asked for. */
  questionSetsFormat?: boolean;
}

export const VISION_ANSWER_INSTRUCTIONS =
  "Отвечай на вопрос по изображению в двух разделах. «Видно»: только то, что прямо есть на картинке: люди и предметы, одежда, цвета, расположение, видимый текст дословно. «Предположения»: всё, что выводится, а не видно: кто это, что за персонаж или мем, бренд, модель, место, время, назначение; каждое со словом «возможно» и с признаками, на которых оно держится. Не выдавай предположение за факт и не называй уверенность выше, чем дают признаки. Если предполагать нечего, так и напиши.";

/** One vision call: the question and the image, with the sections unless the question sets a format. */
export async function analyzeWithVision(
  input: ImageAnalysisInput,
  vision: { model: LanguageModel; run: typeof generateText },
): Promise<string> {
  const result = await vision.run({
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    maxRetries: 0,
    messages: [
      {
        content: [
          { text: input.question, type: "text" },
          { data: input.bytes, mediaType: input.mediaType, type: "file" },
        ],
        role: "user",
      },
    ],
    model: vision.model,
    ...(input.questionSetsFormat === true ? {} : { system: VISION_ANSWER_INSTRUCTIONS }),
  });
  return result.text;
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
      questionSetsFormat?: boolean;
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
      ...(input.questionSetsFormat === true ? { questionSetsFormat: true } : {}),
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
    return await analyzeWithVision(input, { model: visionModel, run: generateText });
  },
  ...workspaceImageReaderDependencies,
  supportsImageInput: modelProviderConfig.agent.models.vision.supportsImageInput,
});
