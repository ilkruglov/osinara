#!/bin/bash
# PostgreSQL deployment proposal state transitions.
# Reconciles stale leases, atomically claims one exact-owner proposal, and records terminal results.

readonly DEPLOYMENT_LEASE_INTERVAL="60 minutes"

psql_current() {
  compose_current exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
    --username osinara --dbname osinara --no-align --tuples-only --quiet "$@"
}

# Workflow runs doing work right now: a step in flight (its last event opens or carries a step,
# younger than 10 minutes, so a stuck run does not hold a deploy), a message the session has yet to
# take, or any event in the last 5 seconds (the pause between two steps). A session waiting for
# the next message and a turn waiting for an approval end on a completed step or a created hook.
active_workflow_runs_sql() {
  cat <<'SQL'
SELECT count(*)
  FROM workflow.workflow_runs AS run
  JOIN LATERAL (
    SELECT event.type, event.created_at
      FROM workflow.workflow_events AS event
     WHERE event.run_id = run.id
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT 1
  ) AS last ON true
 WHERE run.status IN ('pending', 'running')
   AND ((last.type IN ('run_created', 'run_started', 'step_created', 'step_started', 'step_retrying',
                       'attr_set', 'hook_received')
         AND last.created_at > LOCALTIMESTAMP - interval '10 minutes')
     OR last.created_at > LOCALTIMESTAMP - interval '5 seconds');
SQL
}

# One poll within `seconds`: the host kills a hung docker exec, PostgreSQL ends a slow statement or
# a lock wait. Codex review, 3 October 2026: the drain ceiling was checked only between polls.
count_active_workflow_runs() {
  local seconds="$1"
  {
    printf "SET statement_timeout = '%ss';\nSET lock_timeout = '2s';\n" "$seconds"
    active_workflow_runs_sql
  } | compose_current_within "$seconds" exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
    --username osinara --dbname osinara_workflow --no-align --tuples-only --quiet
}

# Work the agent took from the application database that is not a Workflow run yet: a message
# claimed but not dispatched, or dispatched in the last 5 minutes (nothing records that Eve took it,
# and before its run exists onMessage may wait out a group's pacing and a 429 pause; 5 minutes is
# the drain's own ceiling, Codex review of the drain fix, 9 November 2026);
# a schedule run claimed or dispatching under a live lease; a memory review batch leased, or
# dispatching in the last 10 minutes. The pause stops new claims; a claim that read no pause had
# committed before the pause did (pause_new_turns waits for it) and is counted here until its run
# exists, where the Workflow count alone let the stop cut it (/code-review of 1.8.57–1.8.58). A turn
# waiting for an approval holds none of these: its message ends at the session's waiting event.
claimed_turn_work_rows_sql() {
  cat <<'SQL'
SELECT 'ingress' AS kind, update_id::text AS id FROM telegram_ingress_updates
 WHERE status = 'processing' AND lease_expires_at > now()
   AND (dispatch_started_at IS NULL OR dispatch_started_at > now() - interval '5 minutes')
UNION ALL
SELECT 'schedule', run.id::text FROM agent_schedule_runs AS run
  JOIN agent_schedules AS schedule
    ON schedule.id = run.schedule_id AND schedule.lease_token = run.lease_token
 WHERE run.status IN ('claimed', 'dispatching')
   AND schedule.status = 'leased' AND schedule.lease_expires_at > now()
UNION ALL
SELECT 'memory_review', id::text FROM memory_review_batches
 WHERE (status = 'leased' AND lease_expires_at > now())
    OR (status = 'dispatching' AND updated_at > now() - interval '10 minutes')
SQL
}

claimed_turn_work_sql() {
  printf 'SELECT count(*) FROM (\n%s\n) AS claimed;\n' "$(claimed_turn_work_rows_sql)"
}

# One poll of the claimed work within `seconds`, bounded like `count_active_workflow_runs`.
count_claimed_turn_work() {
  local seconds="$1"
  {
    printf "SET statement_timeout = '%ss';\nSET lock_timeout = '2s';\n" "$seconds"
    claimed_turn_work_sql
  } | compose_current_within "$seconds" exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
    --username osinara --dbname osinara --no-align --tuples-only --quiet
}

# New turns wait while a deploy drains the running ones: the webhook path and the minute schedules
# of the agent would otherwise start a turn the stop then cuts (Codex review, 6 November 2026).
# The pause lives in the application database and is checked where a turn is claimed
# (`agent/lib/deploy/turn-start-pause.ts`). It ends by itself after 15 minutes, so a controller that
# dies mid-deploy cannot hold the agent; a release without the table (older than migration 143)
# is left alone. Each call is bounded like a drain poll.
readonly TURN_PAUSE_QUERY_SECONDS=20

turn_pause_sql() {
  local statement="$1"
  printf "SET statement_timeout = '%ss';\nSET lock_timeout = '2s';\n" "$TURN_PAUSE_QUERY_SECONDS"
  cat <<SQL
DO \$\$
BEGIN
  IF to_regclass('public.deploy_turn_pause') IS NOT NULL THEN
    ${statement}
  END IF;
END
\$\$;
SQL
}

# The claims take this lock shared before they read the pause (TURN_START_LOCK_SQL in
# agent/lib/deploy/turn-start-pause.ts); taken alone here, the pause commits only after every claim
# that could have missed it, so the wait's first poll sees them all (/code-review of the drain fix,
# 9 November 2026). A claim runs a few queries, so the lock is waited for up to 15 s.
pause_new_turns() {
  turn_pause_sql "PERFORM set_config('lock_timeout', '15s', true);
    PERFORM pg_advisory_xact_lock(hashtextextended('osinara.turn_start', 0));
    INSERT INTO deploy_turn_pause (singleton, paused_until) VALUES (true, now() + interval '15 minutes')
      ON CONFLICT (singleton) DO UPDATE SET paused_until = EXCLUDED.paused_until, requested_at = now();" |
    compose_current_within "$TURN_PAUSE_QUERY_SECONDS" exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
      --username osinara --dbname osinara --no-align --tuples-only --quiet
}

resume_new_turns() {
  turn_pause_sql "DELETE FROM deploy_turn_pause;" |
    compose_current_within "$TURN_PAUSE_QUERY_SECONDS" exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
      --username osinara --dbname osinara --no-align --tuples-only --quiet
}

reconcile_stale_deployments() {
  local stale
  stale="$(psql_current --field-separator=$'\t' <<'SQL'
UPDATE software_update_proposals
   SET status = 'ambiguous',
       result = jsonb_build_object(
         'code', 'DEPLOY_STALE_LEASE_AMBIGUOUS',
         'message', 'Deployment lease expired before a terminal result'
       ),
       result_error_code = 'DEPLOY_STALE_LEASE_AMBIGUOUS',
       result_error_message = 'Deployment lease expired before a terminal result',
       deployment_lease_token = NULL,
       deployment_lease_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
 WHERE status = 'deploying'
   AND deployment_lease_expires_at <= now()
RETURNING id::text, telegram_chat_id, target_version;
SQL
)"
  if [[ -n "$stale" ]]; then
    STALE_DEPLOYMENT_FOUND=1
    local _stale_id
    IFS=$'\t' read -r _stale_id OWNER_CHAT_ID REQUESTED_VERSION <<<"$stale"
    log_event "DEPLOY_STALE_LEASE_AMBIGUOUS" \
      "Expired deploying proposal was marked ambiguous; automatic retry is forbidden"
    send_telegram_notification \
      "Предыдущее обновление v${REQUESTED_VERSION} завершилось неоднозначно после остановки процесса. Код: DEPLOY_STALE_LEASE_AMBIGUOUS"
  fi
}

claim_approved_proposal() {
  read -r LEASE_TOKEN < /proc/sys/kernel/random/uuid
  local claimed
  claimed="$(psql_current --field-separator=$'\t' \
    --set="lease_token=${LEASE_TOKEN}" --set="lease_interval=${DEPLOYMENT_LEASE_INTERVAL}" <<'SQL'
WITH global_owner AS (
  SELECT max(fm.family_id::text)::uuid AS family_id,
         max(fm.user_id::text)::uuid AS user_id,
         max(owner_user.telegram_user_id) AS telegram_user_id
    FROM family_memberships fm
    JOIN users owner_user ON owner_user.id = fm.user_id
   WHERE fm.role = 'owner'
  HAVING count(*) = 1
), candidate AS (
  SELECT proposal.id
    FROM software_update_proposals proposal
    JOIN global_owner owner
      ON owner.family_id = proposal.family_id
     AND owner.user_id = proposal.expected_owner_user_id
     AND owner.telegram_user_id = proposal.expected_owner_telegram_user_id
   WHERE proposal.status = 'approved'
     AND proposal.telegram_chat_type = 'private'
     AND proposal.telegram_chat_id = proposal.expected_owner_telegram_user_id
   ORDER BY proposal.decided_at, proposal.created_at
   FOR UPDATE OF proposal SKIP LOCKED
   LIMIT 1
), claimed AS (
  UPDATE software_update_proposals proposal
     SET status = 'deploying',
         deployment_started_at = now(),
         deployment_lease_token = :'lease_token'::uuid,
         deployment_lease_expires_at = now() + :'lease_interval'::interval,
         updated_at = now()
    FROM candidate
   WHERE proposal.id = candidate.id AND proposal.status = 'approved'
  RETURNING proposal.id::text, proposal.target_version, proposal.telegram_chat_id,
            proposal.manifest->>'version', proposal.manifest->>'commitSha',
            proposal.manifest->>'composeSha256',
            proposal.manifest->'images'->>'app',
            proposal.manifest->'images'->>'edge',
            proposal.manifest->'images'->>'sandboxEgressProxy',
            proposal.manifest->'images'->>'sandboxRunner',
            proposal.manifest->'images'->>'sandboxRuntime',
            COALESCE(proposal.manifest->'images'->>'memoryEmbedding', '')
)
SELECT * FROM claimed;
SQL
)"
  if [[ -z "$claimed" ]]; then
    LEASE_TOKEN=""
    log_event "DEPLOY_NO_APPROVED_PROPOSAL" "No approved exact-owner update is waiting"
    return 0
  fi

  CLAIM_FOUND=1
  IFS=$'\t' read -r PROPOSAL_ID REQUESTED_VERSION OWNER_CHAT_ID \
    STORED_VERSION STORED_COMMIT STORED_COMPOSE_SHA STORED_APP STORED_EDGE \
    STORED_EGRESS STORED_RUNNER STORED_RUNTIME STORED_MEMORY_EMBEDDING <<<"$claimed"
  if [[ ! "$PROPOSAL_ID" =~ ^[0-9a-f-]{36}$ || ! "$OWNER_CHAT_ID" =~ ^-?[0-9]+$ ]]; then
    fail "DEPLOY_PROPOSAL_INVALID" "Claimed proposal has invalid identity fields"
  fi
  require_semver "$REQUESTED_VERSION"
}

recheck_claim_owner() {
  local current
  current="$(psql_current --set="proposal_id=${PROPOSAL_ID}" \
    --set="lease_token=${LEASE_TOKEN}" <<'SQL'
WITH global_owner AS (
  SELECT max(fm.family_id::text)::uuid AS family_id,
         max(fm.user_id::text)::uuid AS user_id,
         max(owner_user.telegram_user_id) AS telegram_user_id
    FROM family_memberships fm
    JOIN users owner_user ON owner_user.id = fm.user_id
   WHERE fm.role = 'owner'
  HAVING count(*) = 1
)
SELECT EXISTS (
  SELECT 1
    FROM software_update_proposals proposal
    JOIN global_owner owner
      ON owner.family_id = proposal.family_id
     AND owner.user_id = proposal.expected_owner_user_id
     AND owner.telegram_user_id = proposal.expected_owner_telegram_user_id
   WHERE proposal.id = :'proposal_id'::uuid
     AND proposal.status = 'deploying'
     AND proposal.deployment_lease_token = :'lease_token'::uuid
     AND proposal.deployment_lease_expires_at > now()
);
SQL
)"
  [[ "$current" == "t" ]] ||
    fail "DEPLOY_OWNER_CHANGED" "Current global owner no longer matches the claimed proposal"
}

record_proposal_result() {
  local status="$1"
  local code="$2"
  local message="$3"
  local updated
  [[ -z "$PROPOSAL_ID" ]] && return 0
  updated="$(psql_current --set="proposal_id=${PROPOSAL_ID}" \
    --set="lease_token=${LEASE_TOKEN}" --set="result_status=${status}" \
    --set="result_code=${code}" --set="result_message=${message}" <<'SQL'
UPDATE software_update_proposals
   SET status = :'result_status',
       result = jsonb_build_object('code', :'result_code', 'message', :'result_message'),
       result_error_code = CASE WHEN :'result_status' = 'succeeded' THEN NULL ELSE :'result_code' END,
       result_error_message = CASE WHEN :'result_status' = 'succeeded' THEN NULL ELSE :'result_message' END,
       deployment_lease_token = NULL,
       deployment_lease_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
 WHERE id = :'proposal_id'::uuid
   AND status = 'deploying'
   AND deployment_lease_token = :'lease_token'::uuid
   AND deployment_lease_expires_at > now()
RETURNING id::text;
SQL
)"
  if [[ "$updated" != "$PROPOSAL_ID" ]]; then
    fail "DEPLOY_PROPOSAL_RESULT_CONFLICT" "Proposal lease no longer belongs to this process"
    return 1
  fi
  TERMINAL_RECORDED=1
}

resolve_initial_owner_chat() {
  local chats
  chats="$(psql_current <<'SQL'
SELECT owner_user.telegram_user_id
  FROM family_memberships fm
  JOIN users owner_user ON owner_user.id = fm.user_id
 WHERE fm.role = 'owner'
 ORDER BY fm.created_at
 LIMIT 2;
SQL
)"
  [[ "$chats" =~ ^-?[0-9]+$ ]] && OWNER_CHAT_ID="$chats"
}
