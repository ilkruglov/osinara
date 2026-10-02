import type { GitHubWebhookVerifier } from "#public/channels/github/verify.js";
/** GitHub App id, supplied directly or resolved lazily from a secret manager. */
export type GitHubAppId = number | string | (() => number | string | Promise<number | string>);
/** GitHub App private key, supplied directly or resolved lazily from a secret manager. */
export type GitHubPrivateKey = string | (() => string | Promise<string>);
/** GitHub webhook secret, supplied directly or resolved lazily from a secret manager. */
export type GitHubWebhookSecret = string | (() => string | Promise<string>);
/**
 * Pre-resolved GitHub installation access token, supplied directly or
 * resolved lazily from a secret manager. When present, eve skips the native
 * `appId`/`privateKey`/`installationId` JWT-minting path. Integrations such
 * as Connect derive the installation token out-of-band and set this field.
 */
export type GitHubInstallationToken = string | (() => string | Promise<string>);
/**
 * The name the channel answers to in `@mentions` (the GitHub App slug,
 * without the `[bot]` suffix), supplied directly or resolved lazily.
 *
 * A lazy resolver runs on first use inside request handling, where
 * credentials that only exist per request (such as the Vercel OIDC token
 * behind Connect metadata lookups) are available; a fulfilled value is
 * cached, and a rejection is retried on the next event instead of pinned.
 */
export type GitHubBotName = string | (() => string | Promise<string>);
/** Credentials used by the native GitHub channel. */
export interface GitHubChannelCredentials {
    readonly appId?: GitHubAppId;
    readonly privateKey?: GitHubPrivateKey;
    readonly webhookSecret?: GitHubWebhookSecret;
    /**
     * The GitHub App's slug (its `@mention` handle, without the `[bot]`
     * suffix), supplied directly or resolved lazily. Used as the channel's
     * `botName` when the config does not set one, so integrations that broker
     * credentials can make mention dispatch work with no explicit
     * configuration.
     */
    readonly appSlug?: GitHubBotName;
    /**
     * Pre-resolved GitHub installation access token. When supplied, eve uses
     * it directly for authenticated GitHub API calls and skips the native
     * `appId`/`privateKey` JWT exchange; `installationId` is not required.
     * Integrations such as Connect derive the token out-of-band and set this
     * field.
     */
    readonly installationToken?: GitHubInstallationToken;
    /**
     * Custom inbound webhook verifier. When supplied, eve skips the
     * `GITHUB_WEBHOOK_SECRET` fallback and delegates verification to this
     * function. Integrations such as Connect authenticate webhooks
     * out-of-band and set this field.
     */
    readonly webhookVerifier?: GitHubWebhookVerifier;
}
/** Options needed by GitHub App auth helpers. */
export interface GitHubAuthApiOptions {
    readonly apiBaseUrl?: string;
    readonly fetch?: typeof fetch;
}
/** Resolves a GitHub App id, falling back to `GITHUB_APP_ID`. */
export declare function resolveGitHubAppId(appId?: GitHubAppId): Promise<string>;
/** Resolves and normalizes a GitHub App private key. */
export declare function resolveGitHubPrivateKey(privateKey?: GitHubPrivateKey): Promise<string>;
/** Resolves a GitHub webhook secret, falling back to `GITHUB_WEBHOOK_SECRET`. */
export declare function resolveGitHubWebhookSecret(webhookSecret?: GitHubWebhookSecret): Promise<string>;
/** The channel's lazily resolved bot name, shared by dispatch and defaults. */
export type GitHubBotNameResolver = () => Promise<string | undefined>;
/**
 * Creates the channel's `botName` resolver: explicit config first, then the
 * credentials' `appSlug`, then `GITHUB_APP_SLUG`. A fulfilled name is cached
 * for the channel's lifetime; a rejection is logged and retried on the next
 * event, so one failed delivery cannot pin the channel to a missing name.
 */
export declare function createGitHubBotNameResolver(input: {
    readonly botName?: GitHubBotName;
    readonly credentials?: GitHubChannelCredentials;
}): GitHubBotNameResolver;
/** Converts hosted-platform escaped newlines back into PEM newlines. */
export declare function normalizeGitHubPrivateKey(privateKey: string): string;
/** Creates a short-lived RS256 GitHub App JWT. */
export declare function createGitHubAppJwt(input: {
    readonly appId?: GitHubAppId;
    readonly now?: Date;
    readonly privateKey?: GitHubPrivateKey;
}): Promise<string>;
/**
 * Resolves an installation access token by minting and caching a GitHub App
 * installation token in process memory.
 */
export declare function resolveGitHubInstallationToken(input: {
    readonly api?: GitHubAuthApiOptions;
    readonly credentials?: GitHubChannelCredentials;
    readonly installationId: number | undefined;
}): Promise<string>;
/**
 * Exchanges a GitHub App JWT for an installation access token, cached until
 * shortly before GitHub's reported expiry.
 */
export declare function createGitHubInstallationToken(input: {
    readonly api?: GitHubAuthApiOptions;
    readonly appId?: GitHubAppId;
    readonly installationId: number;
    readonly privateKey?: GitHubPrivateKey;
}): Promise<string>;
/** Clears the in-memory GitHub installation token cache. Intended for tests. */
export declare function clearGitHubInstallationTokenCache(): void;
/** Seeds the in-memory installation token cache. Intended for tests. */
export declare function seedGitHubInstallationTokenForTests(input: {
    readonly apiBaseUrl?: string;
    readonly appId?: string;
    readonly installationId: number;
    readonly token: string;
}): void;
