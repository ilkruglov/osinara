function withoutInstrumentationContent(e) {
  switch (e.type) {
    case `channel.delivery.started`:
      return Object.freeze({ ...e, input: void 0 });
    case `action.started`:
      return Object.freeze({ ...e, input: void 0 });
    case `action.completed`:
      return Object.freeze({
        ...e,
        output: Object.freeze({ type: e.output.type }),
      });
    case `input.requested`:
      return Object.freeze({ ...e, request: void 0 });
    case `input.resolved`:
      return Object.freeze({ ...e, error: void 0, response: void 0 });
    case `tool.call.started`:
      return Object.freeze({ ...e, input: void 0 });
    case `tool.call.completed`:
      return Object.freeze({
        ...e,
        output: Object.freeze({ type: e.output.type }),
      });
    case `model.call.started`:
      return Object.freeze({ ...e, input: void 0 });
    case `model.call.completed`:
      return Object.freeze({ ...e, content: void 0 });
    case `step.attempt.metadata`:
      return Object.freeze({
        ...e,
        providerMetadata: structuralProviderMetadata(e.providerMetadata),
      });
    case `action.failed`:
    case `model.call.failed`:
    case `session.failed`:
    case `step.attempt.failed`:
    case `tool.call.failed`:
    case `turn.failed`:
    case `channel.delivery.failed`:
      return Object.freeze({ ...e, error: void 0 });
    default:
      return e;
  }
}
function structuralProviderMetadata(e) {
  let t = e.gateway;
  if (typeof t != `object` || !t || Array.isArray(t)) return Object.freeze({});
  let n = t,
    r = {};
  for (let e of [`cost`, `generationId`]) {
    let t = n[e];
    (typeof t == `string` || typeof t == `number`) && (r[e] = t);
  }
  return Object.freeze(
    Object.keys(r).length === 0 ? {} : { gateway: Object.freeze(r) },
  );
}
export { structuralProviderMetadata, withoutInstrumentationContent };
