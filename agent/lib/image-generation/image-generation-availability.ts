/**
 * Runtime availability gate for image generation and the ordered provider chains.
 *
 * Exports:
 * - `resolveImageProviders`: PlusVibe → NeuralDeep → Cloudflare for generation and editing alike
 *   (owner's decision, 28 September 2026): the free klein-4b quota is the last resort because it
 *   draws 512 px and bounds edited references to 512.
 * - `IMAGE_GENERATION_AVAILABLE`: availability for the active validated runtime config.
 */
import { createCloudflareImageClient, createNeuralDeepImageClient, type FluxImageClient } from "./flux-image-clients.js";
import { createPlusVibeImageClient } from "./plusvibe-image-client.js";

export type ImageGenerationEnvironment = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function supportsCloudflareImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.CLOUDFLARE_ACCOUNT_ID) && configured(environment.CLOUDFLARE_AI_TOKEN);
}

function supportsNeuralDeepImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.NEURALDEEP_IMAGE_API_KEY);
}

function supportsPlusVibeImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return configured(environment.PLUSVIBE_API_KEY);
}

/** Ordered providers; only the configured ones are present. */
export function resolveImageProviders(environment: ImageGenerationEnvironment): FluxImageClient[] {
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
  return [plusvibe, neuraldeep, cloudflare].filter((client): client is FluxImageClient => client !== null);
}

export function supportsImageGeneration(environment: ImageGenerationEnvironment): boolean {
  return supportsPlusVibeImageGeneration(environment) ||
    supportsCloudflareImageGeneration(environment) ||
    supportsNeuralDeepImageGeneration(environment);
}

export const IMAGE_GENERATION_AVAILABLE = supportsImageGeneration(process.env);
