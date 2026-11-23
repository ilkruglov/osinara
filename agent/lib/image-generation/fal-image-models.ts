/**
 * The fal image models the owner chooses between with `FAL_IMAGE_MODEL` (22 November 2026).
 *
 * Exports:
 * - `FAL_IMAGE_MODELS`, `FalImageModelId`: each model's endpoints, sizes, fixed parameters and
 *   tariff.
 * - `isFalImageModelId`: whether a configured name is one of them.
 *
 * Key constructs:
 * - GPT Image 2.6 Flare (owner: «картинки включим сейчас на гпт-имедж 2.6 флейр с лоу качеством —
 *   оно быстрее сильно»): always `quality: low` and `reasoning_effort: low`, whatever the tool's
 *   `quality` says; the tool's sizes as exact pixels. The probe of 22 November 2026 took ~10 s a
 *   picture and ~9 s an edit, and wrote Russian lettering right 6 times of 6 (Seedream 2 of 12).
 *   fal prices it by tokens; the estimate is the one the owner reads off the fal dashboard.
 * - Seedream 5.5: the 1.5K tier, $0.03 a picture up to 2.61 MP plus $0.012 for each reference;
 *   `auto` → `auto_1.5K`, fixed sizes → 1536², 1296×1944 and 1944×1296.
 * - A model is data: its endpoints, its sizes, its own fixed parameters and its tariff. The client
 *   adds what every request carries (the prompt, the background, JPEG or PNG for a transparent
 *   background, the references, `sync_mode` for the picture inline).
 */
import type { ImageGenerationRequest } from "./image-generation-client.js";

export type FalImageModelId = "gpt-image-2.6-flare" | "seedream-5.5";

type PixelSize = { height: number; width: number };

interface FalImageModel {
  readonly edit: string;
  /** The tariff as an estimate, or null while the fal dashboard has given none. */
  estimatedUsd(references: number): number | null;
  /** Parameters this model always gets. */
  readonly fixed: Readonly<Record<string, unknown>>;
  readonly sizes: Readonly<Record<ImageGenerationRequest["size"], PixelSize | string>>;
  readonly textToImage: string;
}

export const FAL_IMAGE_MODELS: Readonly<Record<FalImageModelId, FalImageModel>> = {
  "gpt-image-2.6-flare": {
    edit: "openai/gpt-image-2.6/flare/edit",
    estimatedUsd: () => null,
    fixed: { quality: "low", reasoning_effort: "low" },
    sizes: {
      "1024x1024": { height: 1_024, width: 1_024 },
      "1024x1536": { height: 1_536, width: 1_024 },
      "1536x1024": { height: 1_024, width: 1_536 },
      auto: "auto",
    },
    textToImage: "openai/gpt-image-2.6/flare/text-to-image",
  },
  "seedream-5.5": {
    edit: "bytedance/seedream/v5.5/edit",
    estimatedUsd: (references) => Number((0.03 + 0.012 * references).toFixed(3)),
    fixed: {},
    sizes: {
      "1024x1024": { height: 1_536, width: 1_536 },
      "1024x1536": { height: 1_944, width: 1_296 },
      "1536x1024": { height: 1_296, width: 1_944 },
      auto: "auto_1.5K",
    },
    textToImage: "bytedance/seedream/v5.5/text-to-image",
  },
};

export function isFalImageModelId(value: string): value is FalImageModelId {
  return Object.hasOwn(FAL_IMAGE_MODELS, value);
}
