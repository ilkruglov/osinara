/**
 * Application-owned proactive software update checker.
 *
 * Exports:
 * - `createSoftwareUpdateChecker`: dependency-injected latest-release proposal workflow.
 * - `runSoftwareUpdateCheck`: production six-hour schedule operation.
 *
 * A proposal is started by the bot, so an owner chat Telegram already calls unreachable (bot blocked,
 * account deleted) gets no proposal row at all: a created row is deduplicated by version, so a skipped
 * one would never be offered again. The next check after the owner writes again proposes it as usual.
 */
import { createHash, randomBytes } from "node:crypto";

import { CURRENT_SOFTWARE_VERSION } from "./current-version.js";
import {
  githubSoftwareReleaseClient,
  type GitHubSoftwareReleaseClient,
} from "./github-release-client.js";
import { deliverSoftwareUpdateProposal } from "./proposal-delivery.js";
import { softwareUpdateRepository } from "./repository.js";
import type { TelegramRecipientUnreachableReason } from "../telegram-reachability/recipient-failure.js";
import { unreachableTelegramRecipient } from "../telegram-reachability/reachability-guard.js";
import type {
  DeliverSoftwareUpdateProposalInput,
  SoftwareUpdateRepository,
} from "./types.js";

interface SoftwareUpdateCheckerDependencies {
  createCallbackToken(): string;
  currentVersion: string;
  deliverProposal(input: DeliverSoftwareUpdateProposalInput): Promise<void>;
  releaseClient: GitHubSoftwareReleaseClient;
  repository: Pick<SoftwareUpdateRepository, "findCurrentOwner" | "prepareProposal">;
  /** The reason the owner chat must be skipped; absent in tests that do not need it. */
  unreachableOwner?(chatId: string): Promise<TelegramRecipientUnreachableReason | null>;
}

export type SoftwareUpdateCheckResult =
  | "duplicate"
  | "no_owner"
  | "no_update"
  | "owner_unreachable"
  | "proposed";

export function createSoftwareUpdateChecker(dependencies: SoftwareUpdateCheckerDependencies) {
  return async function checkSoftwareUpdate(): Promise<SoftwareUpdateCheckResult> {
    const release = await dependencies.releaseClient.latestNewerThan(dependencies.currentVersion);
    if (!release) return "no_update";
    const owner = await dependencies.repository.findCurrentOwner();
    if (!owner) return "no_owner";
    // Checked before the durable row: a skipped proposal must stay offerable at the next check.
    if (await dependencies.unreachableOwner?.(owner.telegramUserId) != null) return "owner_unreachable";

    // Only the hash crosses the durable boundary; the random token exists until initial delivery.
    const callbackToken = dependencies.createCallbackToken();
    const prepared = await dependencies.repository.prepareProposal({
      callbackTokenHash: createHash("sha256").update(callbackToken).digest("hex"),
      owner,
      release,
    });
    if (prepared.status === "duplicate") return "duplicate";
    await dependencies.deliverProposal({
      callbackToken,
      owner,
      proposalId: prepared.proposalId,
      release,
    });
    return "proposed";
  };
}

export const runSoftwareUpdateCheck = createSoftwareUpdateChecker({
  createCallbackToken: () => randomBytes(24).toString("base64url"),
  currentVersion: CURRENT_SOFTWARE_VERSION,
  deliverProposal: deliverSoftwareUpdateProposal,
  releaseClient: githubSoftwareReleaseClient,
  repository: softwareUpdateRepository,
  unreachableOwner: (chatId) => unreachableTelegramRecipient(chatId, "software_update"),
});
