/**
 * Image generation contracts and the production client.
 *
 * Exports:
 * - `ImageGenerationRequest`, `GeneratedImage`: strict transport contracts.
 * - `imageGenerationClient`: the configured provider (fal.ai), for generation and editing alike.
 */
import { AppError } from "../app-error.js";
import { resolveImageProvider } from "./image-generation-availability.js";
import type { ImageProviderClient } from "./image-provider.js";
import type { VisionImageMediaType } from "../attachments/telegram-vision-attachment.js";

export type ImageBackground = "auto" | "opaque" | "transparent";
export type ImageQuality = "auto" | "high" | "low" | "medium";
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export interface ImageGenerationRequest {
  background: ImageBackground;
  prompt: string;
  quality: ImageQuality;
  size: ImageSize;
  referenceImages?: readonly ImageReference[];
  /**
   * Called once a provider has accepted a job, before the outcome is known: the caller keeps the
   * job next to its own operation so an unknown outcome can be reconciled with the provider later.
   */
  onProviderJob?: (job: ProviderJob) => Promise<void>;
}

export interface ProviderJob {
  jobId: string;
  model: string;
  provider: string;
}

export interface ImageReference {
  bytes: Uint8Array;
  mediaType: string;
}

/** The formats `validateVisionImageBytes` admits; a generated picture is checked by it. */
export type ImageMediaType = VisionImageMediaType;

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: ImageMediaType;
  model: string;
  revisedPrompt?: string;
}

function productionClient(): ImageProviderClient {
  const client = resolveImageProvider(process.env);
  if (client === null) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
      "Не настроен сервис генерации изображений",
    );
  }
  return client;
}

export const imageGenerationClient = {
  /** fal edits wherever it generates: one check covers both. */
  assertConfigured(): void {
    productionClient();
  },
  async generate(input: ImageGenerationRequest): Promise<GeneratedImage> {
    return productionClient().generate(input);
  },
};
