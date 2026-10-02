import { createSign } from "node:crypto";
import { createLogger } from "#internal/logging.js";
import { isObject } from "#shared/guards.js";
const log = createLogger(`github.auth`),
  installationTokenCache = new Map();
async function resolveGitHubAppId(e) {
  let t = e ?? process.env.GITHUB_APP_ID;
  if (t === void 0 || t === ``)
    throw Error(`githubChannel: GITHUB_APP_ID is required.`);
  let n = typeof t == `function` ? await t() : t;
  return String(n);
}
async function resolveGitHubPrivateKey(e) {
  let t = e ?? process.env.GITHUB_APP_PRIVATE_KEY;
  if (!t) throw Error(`githubChannel: GITHUB_APP_PRIVATE_KEY is required.`);
  return normalizeGitHubPrivateKey(typeof t == `function` ? await t() : t);
}
async function resolveGitHubWebhookSecret(e) {
  let t = e ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!t) throw Error(`githubChannel: GITHUB_WEBHOOK_SECRET is required.`);
  return typeof t == `function` ? await t() : t;
}
function createGitHubBotNameResolver(e) {
  let t;
  return async () => {
    if (t !== void 0) return t;
    let n = e.botName ?? e.credentials?.appSlug ?? process.env.GITHUB_APP_SLUG;
    if (n !== void 0) {
      if (typeof n == `string`) return ((t = normalizeBotName(n)), t);
      try {
        return ((t = normalizeBotName(await n())), t);
      } catch (e) {
        log.warn(
          `githubChannel: botName resolver failed; retrying on the next event`,
          { error: e },
        );
        return;
      }
    }
  };
}
function normalizeBotName(e) {
  let t = e.trim();
  return t.length > 0 ? t : void 0;
}
function normalizeGitHubPrivateKey(e) {
  return e.replace(
    /\\n/gu,
    `
`,
  );
}
async function createGitHubAppJwt(t) {
  let n = await resolveGitHubAppId(t.appId),
    r = await resolveGitHubPrivateKey(t.privateKey),
    i = Math.floor((t.now?.getTime() ?? Date.now()) / 1e3),
    a = { alg: `RS256`, typ: `JWT` },
    o = { exp: i + 600, iat: i - 60, iss: n },
    s = `${base64UrlJson(a)}.${base64UrlJson(o)}`;
  return `${s}.${createSign(`RSA-SHA256`).update(s).sign(r, `base64url`)}`;
}
async function resolveGitHubInstallationToken(e) {
  let t = e.credentials?.installationToken;
  if (t !== void 0) return typeof t == `function` ? await t() : t;
  if (e.installationId === void 0)
    throw Error(
      `githubChannel: installationId is required for authenticated GitHub API calls.`,
    );
  return createGitHubInstallationToken({
    api: e.api,
    appId: e.credentials?.appId,
    installationId: e.installationId,
    privateKey: e.credentials?.privateKey,
  });
}
async function createGitHubInstallationToken(e) {
  let t = await resolveGitHubAppId(e.appId),
    r = e.api?.apiBaseUrl ?? `https://api.github.com`,
    a = `${r}:${t}:${e.installationId}`,
    o = installationTokenCache.get(a);
  if (o !== void 0 && Date.now() < o.expiresAtMs - 6e4) return o.token;
  let s = await createGitHubAppJwt({ appId: t, privateKey: e.privateKey }),
    c = await (e.api?.fetch ?? fetch)(
      `${r}/app/installations/${e.installationId}/access_tokens`,
      {
        headers: {
          accept: `application/vnd.github+json`,
          authorization: `Bearer ${s}`,
          "x-github-api-version": `2022-11-28`,
        },
        method: `POST`,
      },
    ),
    l = await parseJsonBody(c);
  if (!c.ok)
    throw Error(
      `githubChannel: create installation token failed with HTTP ${c.status}.`,
    );
  if (!isObject(l) || typeof l.token != `string`)
    throw Error(
      `githubChannel: installation token response did not include a token.`,
    );
  let u = parseExpiryMs(l.expires_at);
  return (
    installationTokenCache.set(a, { expiresAtMs: u, token: l.token }),
    l.token
  );
}
function clearGitHubInstallationTokenCache() {
  installationTokenCache.clear();
}
function seedGitHubInstallationTokenForTests(e) {
  let t = e.apiBaseUrl ?? `https://api.github.com`,
    n = e.appId ?? `test-app`;
  installationTokenCache.set(`${t}:${n}:${e.installationId}`, {
    expiresAtMs: Date.now() + 3600 * 1e3,
    token: e.token,
  });
}
function base64UrlJson(e) {
  return Buffer.from(JSON.stringify(e)).toString(`base64url`);
}
async function parseJsonBody(e) {
  let t = await e.text();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
function parseExpiryMs(e) {
  if (typeof e == `string`) {
    let t = Date.parse(e);
    if (Number.isFinite(t)) return t;
  }
  return Date.now() + 3600 * 1e3;
}
export {
  clearGitHubInstallationTokenCache,
  createGitHubAppJwt,
  createGitHubBotNameResolver,
  createGitHubInstallationToken,
  normalizeGitHubPrivateKey,
  resolveGitHubAppId,
  resolveGitHubInstallationToken,
  resolveGitHubPrivateKey,
  resolveGitHubWebhookSecret,
  seedGitHubInstallationTokenForTests,
};
