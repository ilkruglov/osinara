import { z } from "#compiled/zod/index.js";
import { setTimeout } from "node:timers/promises";
const PHOTON_DASHBOARD_HOST = `https://app.photon.codes`,
  PHOTON_SPECTRUM_HOST = `https://spectrum.photon.codes`,
  PHOTON_DEVICE_CLIENT_ID = `photon-cli`,
  E164 = /^\+[1-9]\d{6,14}$/;
function validatePhotonPhoneNumber(e) {
  let t = e.trim();
  return E164.test(t)
    ? t.startsWith(`+1`) && t.length !== 12
      ? `US and Canadian numbers must be +1 followed by exactly 10 digits`
      : null
    : `Use E.164 format: + followed by 7–15 digits, for example +15551234567`;
}
const DeviceAuthorizationSchema = z.object({
    device_code: z.string().min(1),
    user_code: z.string().min(1),
    verification_uri_complete: z.string().url().optional(),
    verification_uri: z.string().url().optional(),
    expires_in: z.number().positive().optional(),
    interval: z.number().positive().optional(),
  }),
  DeviceTokenSchema = z.object({
    access_token: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  }),
  ProjectSchema = z.object({ id: z.string().min(1) }),
  ProjectSecretSchema = z.object({ projectSecret: z.string().min(1) }),
  ErrorResponseSchema = z.object({
    error: z.unknown().optional(),
    message: z.unknown().optional(),
  }),
  PhoneRegistrationSchema = z.object({
    data: z.object({ assignedPhoneNumber: z.string().min(1) }),
  }),
  DedicatedLineSchema = z.object({
    data: z.object({ line: z.object({ phoneNumber: z.string().min(1) }) }),
  }),
  defaultDeps = {
    fetch,
    delay: (e, n) => setTimeout(e, void 0, { signal: n }),
  };
function errorDetail(e, t) {
  let n = ErrorResponseSchema.safeParse(e);
  return String(n.success ? (n.data.error ?? n.data.message ?? t) : t);
}
function parsePhotonResponse(e, t, n) {
  let r = e.safeParse(t);
  if (!r.success) throw Error(n);
  return r.data;
}
async function json(e, t) {
  let n = await e.json().catch(() => void 0);
  if (!e.ok) throw Error(`Photon ${t} failed: ${errorDetail(n, e.statusText)}`);
  return n;
}
function bearer(e) {
  return { authorization: `Bearer ${e}`, "content-type": `application/json` };
}
function basic(e, t) {
  return {
    authorization: `Basic ${Buffer.from(`${e}:${t}`).toString(`base64`)}`,
    "content-type": `application/json`,
  };
}
async function requestDeviceCode(e) {
  let t = await e.fetch(`${PHOTON_DASHBOARD_HOST}/api/auth/device/code`, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify({
        client_id: PHOTON_DEVICE_CLIENT_ID,
        scope: `openid profile email`,
      }),
    }),
    r = parsePhotonResponse(
      DeviceAuthorizationSchema,
      await json(t, `device login`),
      `Photon returned an invalid device authorization response.`,
    ),
    a = r.verification_uri_complete ?? r.verification_uri;
  if (a === void 0)
    throw Error(`Photon returned an invalid device authorization response.`);
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUrl: a,
    expiresIn: r.expires_in ?? 1800,
    interval: r.interval ?? 5,
  };
}
async function pollForToken(e, t, r) {
  let a = Date.now() + e.expiresIn * 1e3,
    o = e.interval * 1e3;
  for (; Date.now() < a; ) {
    await t.delay(o, r);
    let a = await t.fetch(`${PHOTON_DASHBOARD_HOST}/api/auth/device/token`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({
          grant_type: `urn:ietf:params:oauth:grant-type:device_code`,
          device_code: e.deviceCode,
          client_id: PHOTON_DEVICE_CLIENT_ID,
        }),
        signal: r,
      }),
      s = await a.json().catch(() => void 0);
    if (a.ok) {
      let e = parsePhotonResponse(
        DeviceTokenSchema,
        s,
        `Photon approved device login without returning an access token.`,
      );
      if (e.access_token !== void 0) return e.access_token;
      if (e.accessToken !== void 0) return e.accessToken;
      throw Error(
        `Photon approved device login without returning an access token.`,
      );
    }
    let c = ErrorResponseSchema.safeParse(s),
      l = c.success ? (c.data.error ?? c.data.message) : void 0;
    if (l !== `authorization_pending`) {
      if (l === `slow_down` || a.status === 429) {
        o += a.status === 429 ? 1e4 : 5e3;
        continue;
      }
      throw Error(`Photon device login failed: ${String(l ?? a.statusText)}`);
    }
  }
  throw Error(`Photon device login timed out.`);
}
async function createProject(e, t, r) {
  let i = await r.fetch(`${PHOTON_DASHBOARD_HOST}/api/projects`, {
    method: `POST`,
    headers: bearer(e),
    body: JSON.stringify({
      name: t,
      location: `United States`,
      platforms: [`imessage`],
      template: !1,
      observability: !1,
    }),
  });
  return parsePhotonResponse(
    ProjectSchema,
    await json(i, `project creation`),
    `Photon did not return a project ID.`,
  ).id;
}
async function regenerateSecret(e, t, r) {
  let i = await r.fetch(
    `${PHOTON_DASHBOARD_HOST}/api/projects/${encodeURIComponent(t)}/regenerate-secret`,
    { method: `POST`, headers: bearer(e), body: `{}` },
  );
  return parsePhotonResponse(
    ProjectSecretSchema,
    await json(i, `project credential provisioning`),
    `Photon did not return the new project secret.`,
  ).projectSecret;
}
async function registerUser(e, t, n, i) {
  let a = await i.fetch(
    `${PHOTON_SPECTRUM_HOST}/projects/${encodeURIComponent(e)}/users/`,
    {
      method: `POST`,
      headers: basic(e, t),
      body: JSON.stringify({ type: `shared`, phoneNumber: n }),
    },
  );
  return parsePhotonResponse(
    PhoneRegistrationSchema,
    await json(a, `phone registration`),
    `Photon returned an invalid phone registration response.`,
  ).data.assignedPhoneNumber;
}
async function findDedicatedPhotonLine(e) {
  let t = await (e.deps?.fetch ?? fetch)(
    `${PHOTON_SPECTRUM_HOST}/projects/${encodeURIComponent(e.projectId)}/lines/route`,
    { headers: basic(e.projectId, e.projectSecret) },
  );
  if (t.status !== 404)
    return parsePhotonResponse(
      DedicatedLineSchema,
      await json(t, `dedicated line lookup`),
      `Photon returned an invalid dedicated line response.`,
    ).data.line.phoneNumber;
}
async function deleteProject(e, t, r) {
  let i = await r.fetch(
    `${PHOTON_DASHBOARD_HOST}/api/projects/${encodeURIComponent(t)}`,
    { method: `DELETE`, headers: bearer(e) },
  );
  !i.ok && i.status !== 404 && (await json(i, `project cleanup`));
}
async function provisionPhotonProject(e) {
  let t = e.phoneNumber.trim(),
    n = validatePhotonPhoneNumber(t);
  if (n !== null) throw Error(`Photon phone number is invalid. ${n}.`);
  let r = e.deps ?? defaultDeps,
    i = await requestDeviceCode(r);
  e.onAuthorization({
    userCode: i.userCode,
    verificationUrl: i.verificationUrl,
  });
  let a = await pollForToken(i, r, e.signal),
    o = await createProject(a, e.projectName, r),
    cleanup = () => deleteProject(a, o, r);
  try {
    let e = await regenerateSecret(a, o, r),
      n = await registerUser(o, e, t, r);
    return n === void 0
      ? { projectId: o, projectSecret: e, cleanup }
      : { projectId: o, projectSecret: e, assignedPhoneNumber: n, cleanup };
  } catch (e) {
    throw (await cleanup().catch(() => {}), e);
  }
}
async function usePhotonProject(e) {
  let t = e.projectId.trim(),
    n = e.projectSecret.trim();
  if (!t || !n)
    throw Error(`Photon project ID and project secret are required.`);
  let r =
    e.dedicatedLine ??
    (await findDedicatedPhotonLine({
      projectId: t,
      projectSecret: n,
      deps: e.deps,
    }));
  if (r !== void 0)
    return {
      projectId: t,
      projectSecret: n,
      assignedPhoneNumber: r,
      cleanup: async () => {},
    };
  if (e.phoneNumber === void 0)
    throw Error(
      `Photon phone number is required for projects without a dedicated line.`,
    );
  let i = e.phoneNumber.trim(),
    a = validatePhotonPhoneNumber(i);
  if (a !== null) throw Error(`Photon phone number is invalid. ${a}.`);
  return {
    projectId: t,
    projectSecret: n,
    assignedPhoneNumber: await registerUser(t, n, i, e.deps ?? defaultDeps),
    cleanup: async () => {},
  };
}
export {
  findDedicatedPhotonLine,
  provisionPhotonProject,
  usePhotonProject,
  validatePhotonPhoneNumber,
};
