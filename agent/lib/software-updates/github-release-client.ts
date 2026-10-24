/**
 * GitHub release and deployment-manifest client.
 *
 * Exports:
 * - `GitHubSoftwareReleaseClient`: latest accepted release lookup contract.
 * - `createGitHubSoftwareReleaseClient`: bounded, no-retry GitHub client factory.
 * - `githubSoftwareReleaseClient`: production client for ilkruglov/osinara.
 *
 * Key construct:
 * - Reads anonymously, or with an optional read-only token (`OSINARA_GITHUB_TOKEN`) so a private
 *   repository works too; the manifest comes through the API asset endpoint, which serves both,
 *   while the browser download URL serves only a public repository. Fetch drops the Authorization
 *   header on the cross-origin redirect to the asset storage.
 */
import { z } from "zod";

import {
  SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES,
  SOFTWARE_UPDATE_HTTP_TIMEOUT_MS,
  SOFTWARE_UPDATE_MANIFEST_MAX_BYTES,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { readBoundedBody } from "../bounded-body.js";
import { compareSemver, stableVersionFromTag } from "./semver.js";
import type { SoftwareRelease, SoftwareUpdateManifest } from "./types.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/ilkruglov/osinara/releases/latest";
const MANIFEST_ASSET_NAME = "osinara-deployment.json";
const GITHUB_API_VERSION = "2026-03-10";
const IMAGE_DIGEST = "[0-9a-f]{64}";
const NO_RELEASE = Symbol("no-published-release");

const releaseSchema = z.object({
  assets: z.array(z.object({
    browser_download_url: z.url(),
    name: z.string(),
    state: z.string(),
    url: z.url(),
  })),
  draft: z.boolean(),
  html_url: z.url(),
  immutable: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string(),
});

const manifestSchema = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  composeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  images: z.object({
    app: z.string().regex(new RegExp(`^ghcr\\.io/ilkruglov/osinara-app@sha256:${IMAGE_DIGEST}$`)),
    edge: z.string().regex(new RegExp(`^ghcr\\.io/ilkruglov/osinara-edge@sha256:${IMAGE_DIGEST}$`)),
    sandboxEgressProxy: z.string().regex(
      new RegExp(`^ghcr\\.io/ilkruglov/osinara-sandbox-egress-proxy@sha256:${IMAGE_DIGEST}$`),
    ),
    sandboxRunner: z.string().regex(
      new RegExp(`^ghcr\\.io/ilkruglov/osinara-sandbox-runner@sha256:${IMAGE_DIGEST}$`),
    ),
    sandboxRuntime: z.string().regex(
      new RegExp(`^ghcr\\.io/ilkruglov/osinara-sandbox-runtime@sha256:${IMAGE_DIGEST}$`),
    ),
    // Named by releases after 1.8.20 (BERTA exported to ONNX); a release without it still installs.
    memoryEmbedding: z.string().regex(
      new RegExp(`^ghcr\\.io/ilkruglov/osinara-memory-embedding@sha256:${IMAGE_DIGEST}$`),
    ).optional(),
  }).strict(),
  schemaVersion: z.literal(1),
  version: z.string(),
}).strict();

export interface GitHubSoftwareReleaseClient {
  latestNewerThan(currentVersion: string): Promise<SoftwareRelease | null>;
}

interface GitHubSoftwareReleaseClientDependencies {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Read-only token for a private repository; anonymous when absent. */
  token?: string | undefined;
}

const ASSET_API_URL = /^https:\/\/api\.github\.com\/repos\/ilkruglov\/osinara\/releases\/assets\/\d+$/u;
const TOKEN_FORMAT = /^[A-Za-z0-9_]{20,255}$/u;

async function responseJson(
  response: Response,
  maxBytes: number,
  code: string,
  message: string,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maxBytes, () => new AppError(code, message));
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.error(JSON.stringify({
      code,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof Error) error.message = `${code}: ${message}`;
    throw error;
  }
}

function requireRepositoryUrl(value: string, expectedPath: string, code: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new AppError(code, "GitHub вернул ссылку на релиз из неожиданного источника");
  }
  return value;
}

export function createGitHubSoftwareReleaseClient(
  dependencies: GitHubSoftwareReleaseClientDependencies,
): GitHubSoftwareReleaseClient {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_TIMEOUT_INVALID",
      "Тайм-аут проверки обновлений должен быть положительным целым числом",
    );
  }

  const token = dependencies.token?.trim() || undefined;
  if (token !== undefined && !TOKEN_FORMAT.test(token)) {
    throw new AppError("AGENT_SOFTWARE_UPDATE_TOKEN_INVALID", "OSINARA_GITHUB_TOKEN имеет неожиданный формат");
  }

  async function request(url: string, maxBytes: number, code: string, message: string, allowMissing = false, accept = "application/vnd.github+json") {
    // Every endpoint is called exactly once with its own bounded signal.
    const response = await dependencies.fetch(url, {
      headers: {
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "osinara-software-update-checker",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(dependencies.timeoutMs),
    });
    if (allowMissing && response.status === 404) return NO_RELEASE;
    if (!response.ok) {
      throw new AppError(
        "AGENT_SOFTWARE_RELEASE_REQUEST_FAILED",
        `GitHub не выполнил проверку обновлений (HTTP ${response.status})`,
      );
    }
    return responseJson(response, maxBytes, code, message);
  }

  return {
    async latestNewerThan(currentVersion) {
      const releaseJson = await request(
        LATEST_RELEASE_URL,
        SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES,
        "AGENT_SOFTWARE_RELEASE_INVALID",
        "GitHub вернул некорректные данные последнего релиза",
        true,
      );
      if (releaseJson === NO_RELEASE) return null;
      const parsedRelease = releaseSchema.safeParse(releaseJson);
      if (!parsedRelease.success) {
        throw new AppError(
          "AGENT_SOFTWARE_RELEASE_INVALID",
          "GitHub вернул некорректные данные последнего релиза",
        );
      }
      const release = parsedRelease.data;
      const version = stableVersionFromTag(release.tag_name);
      if (!release.immutable || release.draft || release.prerelease || !version) return null;
      if (compareSemver(version, currentVersion) <= 0) return null;

      // The public URL and unique uploaded asset are constrained to this exact repository and tag.
      const releaseUrl = requireRepositoryUrl(
        release.html_url,
        `/ilkruglov/osinara/releases/tag/${release.tag_name}`,
        "AGENT_SOFTWARE_RELEASE_URL_INVALID",
      );
      const assets = release.assets.filter((asset) =>
        asset.name === MANIFEST_ASSET_NAME && asset.state === "uploaded"
      );
      if (assets.length !== 1) {
        throw new AppError(
          "AGENT_SOFTWARE_MANIFEST_ASSET_INVALID",
          "Релиз должен содержать один готовый манифест osinara-deployment.json",
        );
      }
      requireRepositoryUrl(
        assets[0]!.browser_download_url,
        `/ilkruglov/osinara/releases/download/${release.tag_name}/${MANIFEST_ASSET_NAME}`,
        "AGENT_SOFTWARE_MANIFEST_ASSET_INVALID",
      );
      if (!ASSET_API_URL.test(assets[0]!.url)) {
        throw new AppError("AGENT_SOFTWARE_MANIFEST_ASSET_INVALID", "GitHub вернул ссылку на манифест из неожиданного источника");
      }
      const manifestJson = await request(
        assets[0]!.url,
        SOFTWARE_UPDATE_MANIFEST_MAX_BYTES,
        "AGENT_SOFTWARE_MANIFEST_INVALID",
        "Манифест обновления имеет некорректный формат",
        false,
        "application/octet-stream",
      );
      const parsedManifest = manifestSchema.safeParse(manifestJson);
      if (!parsedManifest.success || parsedManifest.data.version !== version) {
        throw new AppError(
          "AGENT_SOFTWARE_MANIFEST_INVALID",
          "Версия, Compose-файл или образы в манифесте обновления не прошли проверку",
        );
      }
      return {
        manifest: parsedManifest.data as SoftwareUpdateManifest,
        releaseUrl,
        version,
      };
    },
  };
}

export const githubSoftwareReleaseClient = createGitHubSoftwareReleaseClient({
  fetch,
  timeoutMs: SOFTWARE_UPDATE_HTTP_TIMEOUT_MS,
  token: process.env.OSINARA_GITHUB_TOKEN,
});
