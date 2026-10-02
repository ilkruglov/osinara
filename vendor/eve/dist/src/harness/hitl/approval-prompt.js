import { isApprovalRequest } from "#harness/input-request-class.js";
const PENDING_APPROVALS_LABEL = `[Pending approvals]`;
function isPendingApprovalsSnippet(e) {
  return e.startsWith(PENDING_APPROVALS_LABEL);
}
function renderPendingApprovalsSnippet(n) {
  let r = n.filter((t) => isApprovalRequest(t));
  if (r.length !== 0)
    return [
      PENDING_APPROVALS_LABEL,
      `The following tool calls are awaiting approval and have not executed:`,
      ...r.map((e) =>
        JSON.stringify({ requestId: e.requestId, toolName: e.action.toolName }),
      ),
    ].join(`
`);
}
export {
  PENDING_APPROVALS_LABEL,
  isPendingApprovalsSnippet,
  renderPendingApprovalsSnippet,
};
