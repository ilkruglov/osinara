function resolveApprovalPolicy(e) {
  return typeof e == `function` ? e : e.request;
}
export { resolveApprovalPolicy };
