/**
 * Runtime availability gate for image generation and the ordered provider chains.
 *
 * Exports:
 * - `supportsSubscriptionImageGeneration`: pure provider capability check.
 * - `resolveImageProviders`: generation goes PlusVibe → Cloudflare → NeuralDeep (cheapest and
 *   best-looking first, the free quota next); editing goes PlusVibe → NeuralDeep → Cloudflare
 *   (Qwen edits in seconds and keeps the picture's size, klein-4b is bounded to 512).
 * - `IMAGE_GENERATION_AVAILABLE`: availability for the active validated runtime config.
 */
import { modelProviderConfig, type ModelProviderId } from "../model-provider-config.js";
import { createCloudflareImageClient, createNeuralDeepImageClient, type FluxImageClient } from "./flux-image-clients.js";
import { createPlusVibeImageClient } from "./plusvibe-image-client.js";

export function supportsSubscriptionImageGeneration(provider: ModelProviderId): boolean {
  return provider === "codex-subscription";
}

export type ImageGenerationEnvironment = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function supportsCloudflareImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.CLOUDFLARE_ACCOUNT_ID) && configured(environment.CLOUDFLARE_AI_TOKEN);
}

export function supportsNeuralDeepImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.NEURALDEEP_IMAGE_API_KEY);
}

export function supportsPlusVibeImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.PLUSVIBE_API_KEY);
}

/** Ordered providers for one request kind; only the configured ones are present. */
export function resolveImageProviders(environment: ImageGenerationEnvironment, editing = false): FluxImageClient[] {
  const plusvibe = supportsPlusVibeImageGeneration(environment)
    ? createPlusVibeImageClient({ apiKey: environment.PLUSVIBE_API_KEY!.trim() })
    : null;
  const cloudflare = supportsCloudflareImageGeneration(environment)
    ? createCloudflareImageClient({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID!.trim(),
      token: environment.CLOUDFLARE_AI_TOKEN!.trim(),
    })
    : null;
  const neuraldeep = supportsNeuralDeepImageGeneration(environment)
    ? createNeuralDeepImageClient({ apiKey: environment.NEURALDEEP_IMAGE_API_KEY!.trim() })
    : null;
  const ordered = editing ? [plusvibe, neuraldeep, cloudflare] : [plusvibe, cloudflare, neuraldeep];
  return ordered.filter((client): client is FluxImageClient => client !== null);
}

export function supportsImageGeneration(
  provider: ModelProviderId,
  environment: ImageGenerationEnvironment,
): boolean {
  return supportsSubscriptionImageGeneration(provider) ||
    supportsPlusVibeImageGeneration(environment) ||
    supportsCloudflareImageGeneration(environment) ||
    supportsNeuralDeepImageGeneration(environment);
}

export const IMAGE_GENERATION_AVAILABLE = supportsImageGeneration(
  modelProviderConfig.provider,
  process.env,
);
