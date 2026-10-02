import {
  createLogger,
  extractErrorId,
  formatErrorHint,
  logError,
} from "#internal/logging.js";
import { checkoutGitHubRepository } from "#public/channels/github/checkout.js";
import { shouldDispatchGitHubComment } from "#public/channels/github/inbound.js";
import { splitGitHubCommentBody } from "#public/channels/github/limits.js";
const log = createLogger(`github.defaults`);
function defaultGitHubAuth(e) {
  let { sender: t } = e;
  return {
    attributes: {
      conversation_kind: e.conversation.kind,
      delivery_id: e.delivery.id,
      installation_id: String(e.github.installationId ?? ``),
      issue_number: String(e.conversation.issueNumber ?? ``),
      pull_request_number: String(e.conversation.pullRequestNumber ?? ``),
      repository: e.repository.fullName,
      repository_id: String(e.repository.id),
      user_login: t.login,
      user_type: t.type,
    },
    authenticator: `github-webhook`,
    issuer: `github:${e.repository.owner}`,
    principalId: `github:${t.id}`,
    principalType: t.type === `Bot` ? `service` : `user`,
    subject: t.login,
  };
}
async function defaultOnComment(e, t, n) {
  return shouldDispatchGitHubComment({
    author: t.author,
    body: t.body,
    botName: await n.botName?.(),
  })
    ? { auth: defaultGitHubAuth(e) }
    : null;
}
function createDefaultEvents(e = {}) {
  return {
    async "turn.started"(t, n, i) {
      if (e.progress?.reactions !== !1)
        try {
          await n.thread.react(`eyes`);
        } catch (e) {
          logError(log, `GitHub reaction failed — swallowed`, e);
        }
      await checkoutRepositoryForTurn(n, i, e);
    },
    async "message.completed"(e, t, n) {
      e.finishReason === `tool-calls` ||
        !e.message ||
        (await postCommentChunks(t, e.message));
    },
    async "input.requested"(t, n, r) {
      if (t.requests.length === 0) return;
      let i = t.requests.map(renderInputRequest),
        a = renderReplyInstruction(t.requests, await e.botName?.());
      (a !== void 0 && i.push(a),
        await postCommentChunks(
          n,
          i.join(`

`),
        ));
    },
    async "session.failed"(e, r) {
      let i = formatErrorHint(e),
        a = extractErrorId(e.details);
      await postFailure(
        r,
        [
          `This session could not recover from an error${i}.`,
          ``,
          `Start a new comment to continue.`,
          ...(a ? [``, `Error id: ${a}`] : []),
        ].join(`
`),
      );
    },
    async "turn.failed"(e, r, i) {
      let a = formatErrorHint(e),
        o = extractErrorId(e.details);
      await postFailure(
        r,
        [
          `I hit an error while handling your request${a}.`,
          ``,
          `Please try again, rephrase, or reach out if it keeps failing.`,
          ...(o ? [``, `Error id: ${o}`] : []),
        ].join(`
`),
      );
    },
  };
}
function renderInputRequest(e) {
  let t = [e.prompt];
  return (
    e.options !== void 0 &&
      e.options.length > 0 &&
      t.push(
        ``,
        ...e.options.map((e, t) => {
          let n = e.description ? ` - ${e.description}` : ``;
          return `${t + 1}. ${e.label}${n}`;
        }),
      ),
    e.allowFreeform === !0 &&
      t.push(``, `You can also reply with a custom answer.`),
    t.join(`
`)
  );
}
function renderReplyInstruction(e, t) {
  let n = t?.trim();
  return n
    ? `Answer by mentioning me in a reply, e.g. \`@${n} ${e.find((e) => (e.options?.length ?? 0) > 0)?.options?.[0]?.label ?? `<your answer>`}\`.`
    : void 0;
}
async function checkoutRepositoryForTurn(e, t, n) {
  let { state: a } = e;
  try {
    let e = await checkoutGitHubRepository(await t.getSandbox(), {
      api: n.api,
      baseRef: a.baseRef,
      baseSha: a.baseSha,
      credentials: n.credentials,
      defaultBranch: a.defaultBranch,
      headRef: a.headRef,
      headSha: a.headSha,
      includeBase: a.pullRequestNumber !== null,
      installationId: a.installationId,
      owner: a.owner,
      pullRequestNumber: a.pullRequestNumber,
      repo: a.repo,
    });
    ((a.checkoutPath = e.path), (a.headSha = e.sha), (a.baseRef = e.baseRef));
  } catch (e) {
    logError(log, `GitHub checkout failed — swallowed`, e);
  }
}
async function postCommentChunks(e, t) {
  for (let n of splitGitHubCommentBody(t)) await e.thread.post(n);
}
async function postFailure(e, t) {
  await postCommentChunks(e, t);
}
export { createDefaultEvents, defaultGitHubAuth, defaultOnComment };
