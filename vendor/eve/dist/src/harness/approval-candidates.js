const APPROVAL_STATE_KEY = `eve.runtime.hitl.approvalState`;
function createApprovalCandidate(e) {
  let t = expireApprovalCandidates({ now: e.createdAt, state: e.state }),
    n = readApprovalState(t);
  if (n.settlements[e.requestId] !== void 0) return { changed: !1, state: t };
  let r = e.responder;
  if (
    Object.values(n.activeCandidates).find(
      (t) => t.requestId === e.requestId && sameResponder(t.responder, r),
    ) !== void 0
  )
    return { changed: !1, state: t };
  let i =
    n.activeCandidates[e.candidateIdPrefix] !== void 0 ||
    n.candidateHistory.some((t) => t.candidateId === e.candidateIdPrefix)
      ? `${e.candidateIdPrefix}.${n.nextCandidateSequence.toString(36)}`
      : e.candidateIdPrefix;
  if (
    n.activeCandidates[i] !== void 0 ||
    n.candidateHistory.some((e) => e.candidateId === i)
  )
    throw Error(`Approval candidate id collision: "${i}".`);
  let a = {
    candidateId: i,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    requestId: e.requestId,
    responder: r,
    status: `pending`,
  };
  return {
    changed: !0,
    state: writeApprovalState(t, {
      ...n,
      activeCandidates: { ...n.activeCandidates, [a.candidateId]: a },
      nextCandidateSequence: n.nextCandidateSequence + 1,
    }),
  };
}
function markApprovalCandidatePendingEventEmitted(e) {
  let t = readApprovalState(e.state),
    n = t.activeCandidates[e.candidateId];
  return n === void 0 || n.pendingEventEmitted === !0
    ? e.state
    : writeApprovalState(e.state, {
        ...t,
        activeCandidates: {
          ...t.activeCandidates,
          [e.candidateId]: { ...n, pendingEventEmitted: !0 },
        },
      });
}
function markApprovalCandidateHistoryEventEmitted(e) {
  let t = readApprovalState(e.state),
    n = !1,
    r = t.candidateHistory.map((t) =>
      t.candidateId !== e.candidateId || t.eventEmitted === !0
        ? t
        : ((n = !0), { ...t, eventEmitted: !0 }),
    );
  return n
    ? writeApprovalState(e.state, { ...t, candidateHistory: r })
    : e.state;
}
function markApprovalSettlementEventEmitted(e) {
  let t = readApprovalState(e.state),
    n = t.settlements[e.requestId];
  return n === void 0 || n.eventEmitted === !0
    ? e.state
    : writeApprovalState(e.state, {
        ...t,
        settlements: {
          ...t.settlements,
          [e.requestId]: { ...n, eventEmitted: !0 },
        },
      });
}
function markApprovalCandidateAuthorizationRequired(e) {
  let t = readApprovalState(e.state),
    n = t.activeCandidates[e.candidateId];
  if (n === void 0) return e.state;
  let r = {
    ...n,
    authorizationChallenges: e.authorizationChallenges,
    expiresAt: e.expiresAt ?? n.expiresAt,
    status: `authorization-required`,
  };
  return writeApprovalState(e.state, {
    ...t,
    activeCandidates: { ...t.activeCandidates, [e.candidateId]: r },
  });
}
function finishApprovalCandidate(e) {
  let t = readApprovalState(e.state),
    n = t.activeCandidates[e.candidateId];
  if (n === void 0) return e.state;
  let r = { ...t.activeCandidates };
  return (
    delete r[e.candidateId],
    writeApprovalState(e.state, {
      ...t,
      activeCandidates: r,
      candidateHistory: [
        ...t.candidateHistory,
        toCandidateAuditRecord({
          candidate: n,
          completedAt: e.completedAt,
          reason: e.reason,
          status: e.status,
        }),
      ],
    })
  );
}
function expireApprovalCandidates(e) {
  let t = e.state,
    n = Object.values(readApprovalState(t).activeCandidates);
  for (let r of n)
    r.expiresAt > e.now ||
      (t = finishApprovalCandidate({
        candidateId: r.candidateId,
        completedAt: e.now,
        state: t,
        status: `timed-out`,
      }));
  return t;
}
function settleAllowedCandidate(e) {
  let t = expireApprovalCandidates({ now: e.settledAt, state: e.state }),
    n = readApprovalState(t),
    r = n.activeCandidates[e.candidateId];
  if (r === void 0) {
    let r = n.candidateHistory.find((t) => t.candidateId === e.candidateId);
    if ((r && n.settlements[r.requestId]) !== void 0)
      return { changed: !1, state: t };
    throw Error(`Unknown approval candidate "${e.candidateId}".`);
  }
  return settleRequest({
    actor: projectResponder(r.responder),
    candidateId: r.candidateId,
    outcome: `allowed`,
    requestId: r.requestId,
    settledAt: e.settledAt,
    state: t,
  });
}
function settleDirectApprovalResponse(e) {
  let t = expireApprovalCandidates({ now: e.settledAt, state: e.state });
  return settleRequest({
    actor: projectResponder(e.actor),
    outcome: e.outcome,
    requestId: e.requestId,
    settledAt: e.settledAt,
    state: t,
  });
}
function getActiveApprovalCandidate(e, t) {
  return readApprovalState(e).activeCandidates[t];
}
function getApprovalAuditState(e) {
  let t = readApprovalState(e);
  return {
    activeCandidates: Object.values(t.activeCandidates),
    candidateHistory: t.candidateHistory,
    settlements: Object.values(t.settlements),
  };
}
function settleRequest(e) {
  let t = readApprovalState(e.state);
  if (t.settlements[e.requestId] !== void 0)
    return { changed: !1, state: e.state };
  let n = {
      actor: e.actor,
      candidateId: e.candidateId,
      outcome: e.outcome,
      requestId: e.requestId,
      settledAt: e.settledAt,
    },
    r = {},
    i = [...t.candidateHistory];
  for (let n of Object.values(t.activeCandidates)) {
    if (n.requestId !== e.requestId) {
      r[n.candidateId] = n;
      continue;
    }
    i.push(
      toCandidateAuditRecord({
        candidate: n,
        completedAt: e.settledAt,
        status: n.candidateId === e.candidateId ? `allowed` : `stale`,
      }),
    );
  }
  let a = {
    activeCandidates: r,
    candidateHistory: i,
    nextCandidateSequence: t.nextCandidateSequence,
    settlements: { ...t.settlements, [e.requestId]: n },
  };
  return { changed: !0, state: writeApprovalState(e.state, a) };
}
function toCandidateAuditRecord(e) {
  let { authorizationChallenges: t, responder: n, ...r } = e.candidate;
  return {
    ...r,
    completedAt: e.completedAt,
    responder: projectResponder(n),
    reason: e.reason,
    status: e.status,
  };
}
function projectResponder(e) {
  return {
    authenticator: e.authenticator,
    issuer: e.issuer,
    principalId: e.principalId,
    principalType: e.principalType,
  };
}
function sameResponder(e, t) {
  return (
    e.authenticator === t.authenticator &&
    e.issuer === t.issuer &&
    e.principalId === t.principalId &&
    e.principalType === t.principalType
  );
}
function readApprovalState(t) {
  let n = t?.[APPROVAL_STATE_KEY];
  if (typeof n != `object` || !n)
    return {
      activeCandidates: {},
      candidateHistory: [],
      nextCandidateSequence: 0,
      settlements: {},
    };
  let r = n;
  return {
    activeCandidates:
      typeof r.activeCandidates == `object` && r.activeCandidates !== null
        ? r.activeCandidates
        : {},
    candidateHistory: Array.isArray(r.candidateHistory)
      ? r.candidateHistory
      : [],
    nextCandidateSequence:
      typeof r.nextCandidateSequence == `number` &&
      Number.isSafeInteger(r.nextCandidateSequence) &&
      r.nextCandidateSequence >= 0
        ? r.nextCandidateSequence
        : deriveNextCandidateSequence(r),
    settlements:
      typeof r.settlements == `object` && r.settlements !== null
        ? r.settlements
        : {},
  };
}
function deriveNextCandidateSequence(e) {
  return (
    Object.keys(e.activeCandidates ?? {}).length +
    (Array.isArray(e.candidateHistory) ? e.candidateHistory.length : 0)
  );
}
function writeApprovalState(t, n) {
  return { ...t, [APPROVAL_STATE_KEY]: n };
}
export {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getActiveApprovalCandidate,
  getApprovalAuditState,
  markApprovalCandidateAuthorizationRequired,
  markApprovalCandidateHistoryEventEmitted,
  markApprovalCandidatePendingEventEmitted,
  markApprovalSettlementEventEmitted,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
};
