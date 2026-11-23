/**
 * Runtime availability gate for image generation.
 *
 * Exports:
 * - `resolveImageProvider`: the fal.ai client when `FAL_KEY` and `FAL_IMAGE_MODEL` are set, else
 *   null. fal is the only provider (owner's decision, 22 November 2026): when it fails or its
 *   filter refuses, there is no picture, not another provider's. The model is the owner's choice
 *   and has no default («Обязательна»); a name it does not know is a named error, at startup.
 * - `supportsImageGeneration`, `IMAGE_GENERATION_AVAILABLE`: whether the tool exists at all.
 */
import { AppError } from "../app-error.js";
import { createFalImageClient } from "./fal-image-client.js";
import { FAL_IMAGE_MODELS, isFalImageModelId, type FalImageModelId } from "./fal-image-models.js";
import type { ImageProviderClient } from "./image-provider.js";

export type ImageGenerationEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * A fal key is printable ASCII. A Cyrillic letter or a zero-width character pasted with it makes
 * Node refuse the header before anything is sent, a space makes it not a key: the tool would be
 * offered and fail every call.
 */
function falKey(environment: ImageGenerationEnvironment): string | null {
  const key = environment.FAL_KEY?.trim();
  return key && /^[\x21-\x7e]+$/u.test(key) ? key : null;
}

function falModel(environment: ImageGenerationEnvironment): FalImageModelId | null {
  const name = environment.FAL_IMAGE_MODEL?.trim();
  if (!name) return null;
  // The value is not repeated: a key put here by mistake would land in the startup log.
  if (!isFalImageModelId(name)) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      `Неизвестная модель картинок в FAL_IMAGE_MODEL; допустимы ${Object.keys(FAL_IMAGE_MODELS).join(", ")}`,
    );
  }
  return name;
}

export function resolveImageProvider(
  environment: ImageGenerationEnvironment,
): ImageProviderClient | null {
  const apiKey = falKey(environment);
  const model = falModel(environment);
  return apiKey === null || model === null ? null : createFalImageClient({ apiKey, model });
}

export function supportsImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return resolveImageProvider(environment) !== null;
}

/**
 * Why a half-configured generator is off: a key that is set but unusable, a key without a model, a
 * model without a key. Null when it is on or not configured at all. An empty value, as compose
 * leaves an unset variable, is not set.
 */
function configurationGap(environment: ImageGenerationEnvironment): string | null {
  if (environment.FAL_KEY) {
    if (falKey(environment) === null) return "AGENT_IMAGE_GENERATION_KEY_INVALID";
    return falModel(environment) === null ? "AGENT_IMAGE_GENERATION_MODEL_MISSING" : null;
  }
  return falModel(environment) === null ? null : "AGENT_IMAGE_GENERATION_KEY_MISSING";
}

export const IMAGE_GENERATION_AVAILABLE = supportsImageGeneration(process.env);

// The log names the gap, never the key itself.
const gap = configurationGap(process.env);
if (gap !== null) console.error(JSON.stringify({ code: gap }));
