const SANDBOX_PARENT_DEFINITION_MARKER = Symbol.for(
  `eve.sandbox-parent-definition`,
);
function defineSandbox(e) {
  return (
    typeof e == `function` &&
      Object.defineProperty(e, SANDBOX_PARENT_DEFINITION_MARKER, { value: !0 }),
    e
  );
}
export { defineSandbox };
