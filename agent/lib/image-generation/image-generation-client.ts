/**
 * Image generation contracts and the production client.
 *
 * Exports:
 * - `ImageGenerationRequest`, `GeneratedImage`: strict transport contracts.
 * - `imageGenerationClient`: the configured provider chain (PlusVibe → NeuralDeep → Cloudflare);
 *   editing uses only the providers that support it.
 */
import { AppError } from "../app-error.js";
import { createFallbackImageClient } from "./flux-image-clients.js";
import { resolveImageProviders } from "./image-generation-availability.js";
import { editingUnavailable } from "./image-editing-input.js";

export type ImageBackground = "auto" | "opaque" | "transparent";
export type ImageQuality = "auto" | "high" | "low" | "medium";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export interface ImageGenerationRequest {
  background: ImageBackground;
  prompt: string;
  quality: ImageQuality;
  size: ImageSize;
  referenceImages?: readonly ImageReference[];
}

export interface ImageReference {
  bytes: Uint8Array;
  mediaType: string;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: ImageMediaType;
  model: string;
  revisedPrompt?: string;
}

function productionClient(editing = false): { assertConfigured(): void; generate(input: ImageGenerationRequest): Promise<GeneratedImage> } {
  if (editing) {
    const clients = resolveImageProviders(process.env).filter((client) => client.supportsEditing);
    if (clients.length === 0) throw editingUnavailable();
    return createFallbackImageClient(clients);
  }
  const chain = resolveImageProviders(process.env);
  if (chain.length === 0) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      "Не настроен ни один сервис генерации изображений",
    );
  }
  return createFallbackImageClient(chain);
}

export const imageGenerationClient = {
  assertSupportsEditing(): void {
    productionClient(true).assertConfigured();
  },
  assertConfigured(): void {
    productionClient().assertConfigured();
  },
  generate(input: ImageGenerationRequest): Promise<GeneratedImage> {
    return productionClient(Boolean(input.referenceImages?.length)).generate(input);
  },
};
