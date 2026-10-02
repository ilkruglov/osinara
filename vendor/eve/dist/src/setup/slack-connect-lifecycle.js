import {
  parseSlackConnectorDetails,
  parseSlackConnectors,
} from "./slack-connect.js";
import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#setup/scaffold/index.js";
import "#setup/primitives/run-vercel.js";
import "#setup/cli/index.js";
import {
  CONNECT_MUTATION_TIMEOUT_MS,
  replaceConnectTrigger,
} from "#setup/connect-provisioning.js";
const CONNECT_LOOKUP_TIMEOUT_MS = 6e4;
async function listSlackConnectors(e, n, r, i) {
  let o = await e.captureVercel(
    [`connect`, `list`, `-F`, `json`, `--all-projects`],
    { cwd: n, onOutput: r, timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS, signal: i },
  );
  if (!o.ok) return { state: `failed`, message: o.failure.message };
  try {
    let e = JSON.parse(o.stdout);
    if (typeof e != `object` || !e)
      return {
        state: `failed`,
        message: `Vercel returned a malformed connector list.`,
      };
    let n = e;
    return Array.isArray(n.connectors ?? n.clients)
      ? { state: `ok`, body: e, connectors: parseSlackConnectors(e) }
      : {
          state: `failed`,
          message: `Vercel returned a malformed connector list.`,
        };
  } catch {
    return {
      state: `failed`,
      message: `Vercel returned invalid JSON for the connector list.`,
    };
  }
}
async function findSlackConnector(e, t, n, r, i, a) {
  let o = await listSlackConnectors(e, t, i, a);
  if (o.state === `failed`) return o;
  let s = new Set(o.connectors.map((e) => e.uid));
  if (n === void 0) return { state: `not-found`, connectorUids: s };
  let c = o.connectors
    .filter((e) => e.id !== void 0 && e.projectIds.includes(n))
    .sort((e, t) => t.createdAt - e.createdAt)
    .map(({ uid: e, id: t }) => ({ uid: e, id: t }));
  if (c.length === 0) return { state: `not-found`, connectorUids: s };
  let l = c.find((e) => e.uid === r);
  return l === void 0
    ? { state: `found`, connectors: c, connectorUids: s }
    : { state: `found`, connectors: c, preferred: l, connectorUids: s };
}
async function attachSlackConnector(e, t, r, a, o) {
  return replaceConnectTrigger({
    connectorUid: r.uid,
    projectRoot: t,
    triggerPath: SLACK_CHANNEL_DEFAULT_ROUTE,
    onOutput: a,
    signal: o,
    deps: e,
  });
}
async function fetchSlackConnectorDetails(t) {
  let n = t.orgId === void 0 ? `` : `?teamId=${encodeURIComponent(t.orgId)}`,
    r = [
      `api`,
      `/v1/connect/connectors/${encodeURIComponent(t.connectorId)}${n}`,
    ];
  t.orgId !== void 0 && r.push(`--scope`, t.orgId);
  let i = await t.deps.captureVercel(r, {
    cwd: t.projectRoot,
    onOutput: t.onOutput,
    timeoutMs: t.timeoutMs,
    signal: t.signal,
  });
  if (!i.ok) return { state: `failed`, message: i.failure.message };
  try {
    let n = parseSlackConnectorDetails(JSON.parse(i.stdout));
    return n?.ref.id === t.connectorId
      ? { state: `found`, details: n }
      : {
          state: `failed`,
          message: `Vercel returned an invalid Slack connector.`,
        };
  } catch {
    return {
      state: `failed`,
      message: `Vercel returned invalid JSON for the Slack connector.`,
    };
  }
}
async function fetchSlackWorkspace(e) {
  let t = await fetchSlackConnectorDetails(e);
  return t.state === `failed`
    ? t
    : t.details.workspace === void 0
      ? { state: `pending` }
      : { state: `connected`, workspace: t.details.workspace };
}
async function cleanupConnectorUid(e, t) {
  let { log: n, deps: i, projectRoot: a, onOutput: o } = e;
  return (await i.runVercel(
    [`connect`, `remove`, t, `--disconnect-all`, `--yes`],
    { cwd: a, onOutput: o, timeoutMs: CONNECT_MUTATION_TIMEOUT_MS },
  ))
    ? !0
    : (n.warning(
        `Could not remove the abandoned Slack connector. Run \`vercel connect remove ${t} --disconnect-all --yes\` to clean it up.`,
      ),
      !1);
}
async function cleanupConnectorUids(e, t) {
  let n = [];
  for (let r of new Set(t)) (await cleanupConnectorUid(e, r)) || n.push(r);
  return n.length === 0
    ? { state: `clean` }
    : { state: `failed`, connectorUids: n };
}
async function cleanupCreatedAttempt(e, t) {
  if (t.createdRef) return cleanupConnectorUids(e, [t.createdRef.uid]);
  e.log.warning(
    `Vercel returned no connector UID for the abandoned Slack Connect request, so eve cannot prove that request was cancelled. No connector was removed; do not retry until the browser request is no longer usable.`,
  );
  let n = await listSlackConnectors(e.deps, e.projectRoot, e.onOutput);
  return n.state === `failed`
    ? { state: `failed`, connectorUids: [] }
    : {
        state: `failed`,
        connectorUids: n.connectors
          .map((e) => e.uid)
          .filter(
            (e) =>
              (e === t.expectedUid || e.startsWith(`${t.expectedUid}-`)) &&
              !t.baselineConnectorUids.has(e),
          ),
      };
}
export {
  CONNECT_LOOKUP_TIMEOUT_MS,
  attachSlackConnector,
  cleanupCreatedAttempt,
  fetchSlackConnectorDetails,
  fetchSlackWorkspace,
  findSlackConnector,
  listSlackConnectors,
};
