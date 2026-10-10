/**
 * The versions a turn ran under, stamped on every turn evaluation.
 *
 * Export:
 * - `runtimeVersions`: the software version, the hash of the agent model configuration and the
 *   hash of the mode instructions, computed once per process.
 *
 * Key construct:
 * - Evaluations of different versions are never compared with each other. The core instructions
 *   ship with the release, so the software version covers them; the mode blocks and the model
 *   configuration can change on the host without a release, so they carry their own hashes.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../json-hash.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { modeInstructions } from "../prompt/mode-instructions.js";
import { CURRENT_SOFTWARE_VERSION } from "../software-updates/current-version.js";

export interface RuntimeVersions {
  modelConfigHash: string;
  promptHash: string;
  softwareVersion: string;
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32);

function computePromptHash(): string {
  return hash([
    modeInstructions({ environment: "private" }),
    modeInstructions({ environment: "family" }),
    modeInstructions({ capabilities: new Set(), environment: "external" }),
  ]);
}

let cached: RuntimeVersions | null = null;

export function runtimeVersions(): RuntimeVersions {
  cached ??= {
    modelConfigHash: hash(modelProviderConfig.agent),
    promptHash: computePromptHash(),
    softwareVersion: CURRENT_SOFTWARE_VERSION,
  };
  return cached;
}
