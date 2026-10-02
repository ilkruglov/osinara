function resolveEffectiveOutputSchema(e) {
  let { agentOutputSchema: t, input: n, mode: r, session: i } = e;
  return n?.outputSchema === void 0
    ? r === `task` && i.outputSchema === void 0 && t !== void 0
      ? { ...i, outputSchema: t }
      : i
    : { ...i, outputSchema: n.outputSchema };
}
export { resolveEffectiveOutputSchema };
