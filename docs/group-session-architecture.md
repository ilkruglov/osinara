# Group session architecture

## Status

This document records the implemented architecture for Telegram group sessions. It applies to both
family and external groups. Migrations `041` and `042` establish the persisted group-type and
canonical/task-session contracts described below.

The security policy of a group remains independent from its session topology. A family group and
an external group may use the same canonical-session lifecycle without sharing auth, memory,
workspace, tools, prompts, or data.

## Problem

Current routing uses the Telegram message ID of every newly addressed group message as part of the
Eve continuation token. Each independent mention or command therefore creates another durable Eve
session. Replies to an Osinara response resume that particular branch through a stored route alias.

This gives precise reply branches but has undesirable group-chat behavior:

- many active sessions contain overlapping copies of the same group timeline;
- each branch repeatedly pays the system-prompt and bootstrap-context cost;
- abandoned active sessions are not proactively retired;
- compaction, retention, diagnostics, and policy transitions are fragmented;
- users experience one shared room while the model sees many unrelated conversations;
- Osinara already serializes ingress per chat/topic, so the extra sessions provide little useful
  execution parallelism.

The PostgreSQL group timeline already preserves the room-level sequence, authors, agent responses,
reply ancestry, topics, and attachment metadata. It is the correct source of shared group history.

## Eve constraints

The design follows Eve's documented session contract:

- a session is one durable conversation or task;
- a continuation token is the channel-owned resume handle for that conversation;
- one session has one current continuation at a time;
- messages to one session must be delivered sequentially after a waiting boundary;
- Eve does not provide a durable FIFO queue for bursts of messages to one session;
- a parked HITL or authorization turn holds durable state without consuming compute;
- separate sessions execute independently;
- Telegram forum topics are separate conversation threads;
- proactive Telegram messages may anchor independent sessions to their delivered message IDs.

Osinara's durable ingress already owns FIFO ordering per Telegram chat/topic and waits for an Eve
session boundary before releasing the next item. The application must retain this queue rather than
rely on Eve to order concurrent deliveries.

Official references:

- <https://vercel.com/eve>
- <https://eve.dev/docs/concepts/execution-model-and-durability>
- <https://eve.dev/docs/concepts/sessions-runs-and-streaming>
- <https://eve.dev/docs/channels/telegram>

The installed Eve version remains `0.22.5`; implementation must also be verified against its local
documentation and public types.

## Scope

Canonical sessions apply to every registered Telegram group:

- `family_private`;
- `external`.

Session identity is:

```text
registered group ID + verified Telegram forum topic ID
```

A normal non-forum group has one canonical session. A forum has one canonical session for each
verified topic, including the main topic. Ordinary Telegram reply chains do not create separate
canonical sessions.

Personal Telegram chats keep their existing user-scoped session model. Scheduled and proactive
runs remain separate sessions because they are independent tasks with their own delivery lifecycle.

## Canonical session

The canonical session is the current shared Eve conversation for one group/topic.

All ordinary addressed input routes to it:

- a bot command;
- an explicit bot mention;
- a reply to an ordinary Osinara response;
- an owner message accepted by external `owner_only` mode;
- a follow-up that does not target a parked task.

The canonical route must use an application-owned stable key derived only from the verified group
and topic. It must not contain a participant ID, untrusted text, or the triggering Telegram message
ID.

Every turn still carries fresh verified auth for its current author. Sharing an Eve conversation
does not share authority between participants. The model must act only for the author of the current
message, while previous participant messages remain untrusted group history.

Only one active canonical session may exist for one group/topic. This invariant must be enforced by
PostgreSQL, not by process-local state.

## Task promotion

The application must not ask the model to predict whether a message is a task. A normal turn starts
in the canonical session. The session becomes a task session only after an observable durable Eve
boundary proves that the workflow is parked or independently long-lived.

Promotion triggers include:

- `input.requested` for approval, a choice, or free-form input;
- `authorization.required` for OAuth or another connection flow;
- an application job with an explicit durable task ID;
- a scheduled or proactive run that was already created as an independent task.

When a canonical turn parks:

1. Mark the existing application session as `task` and record its requester and pending request.
2. Remove it as the canonical session for the group/topic without moving or copying Eve state.
3. Allow the next ordinary group message to create a new canonical session.
4. Route the exact HITL button, ForceReply, OAuth callback, or approved task continuation back to
   the parked task session.
5. Recheck current authorization at the side-effect boundary.
6. After completion, persist the user-visible outcome in the shared group timeline.
7. Retire the task session when it no longer has a pending operation.

Reclassification is required because an in-flight Eve turn cannot be safely migrated into another
session. The parked session already contains the exact model, tool, approval, and durable workflow
state needed to resume.

An unrelated message from another participant must never answer or cancel a parked request. It
routes to the current canonical session. Requester-bound approval and callback checks remain in
force for family and external groups.

## Application state

The target application contract needs explicit session roles rather than inferring them from age or
the most recent row. The exact schema belongs to the implementation plan, but it must represent:

```text
session kind: canonical | task | scheduled | proactive
task state: running | pending | completed | failed
group ID
verified forum topic ID
requester user ID when applicable
parent or originating canonical session ID when applicable
pending request identity
```

A separate canonical pointer or a partial unique index must guarantee one active canonical session
per group/topic. Task sessions may coexist because each has an exact requester-bound continuation
route.

Session kind and task state are application data. They must never be accepted from model output or
Telegram text.

## Context and timeline

The PostgreSQL group timeline remains the source of room-level context for both family and external
groups.

- A new canonical generation receives the bounded bootstrap window for its verified topic.
- A continued canonical session receives only entries after its timeline cursor.
- The current addressed message is represented exactly once.
- Replies may include bounded ancestry outside the recent window.
- Agent outcomes from completed task sessions enter the shared timeline.
- Internal reasoning, raw tool payloads, secrets, and technical errors never enter the timeline.
- `list_group_history` remains the bounded path for explicit retrieval outside automatic context.

Task session internals are not merged into the canonical Eve history. Only their safe, delivered
outcomes become common room history. This prevents hidden reasoning, credentials, and partial side
effects from leaking between sessions.

Compaction summaries for shared group sessions must preserve participant attribution, unresolved
questions, explicit commitments, and reply relationships. They must not turn historical participant
text into current instructions.

## Trust zones

The common lifecycle does not weaken trust-zone isolation.

### Family group

- Only active members of the same family may dispatch a turn.
- The session receives only `family` memory scope.
- It uses the family workspace and trusted family sandbox policy.
- Current membership and role are rechecked where required.
- Credentials and pending operations remain subject to existing family rules.

### External group

- Any Telegram participant accepted by the registered external group may dispatch, subject to its
  message mode.
- The session receives only its own `group` memory scope.
- Personal and family memory, workspaces, connections, and credentials remain unavailable.
- The current persisted capability policy is intersected with the session snapshot before every
  model step.
- `owner_only` remains an external-only message mode.
- The public-group model policy continues to treat chat, timeline, sites, files, photos, and tool
  results as untrusted data.

No canonical session, task session, route, cursor, sandbox identity, or summary may cross a group ID,
family ID, scope, or trust-zone replacement.

## Concurrency and delivery

The existing durable ingress queue remains authoritative:

- FIFO is scoped to a Telegram chat/topic;
- only one item is dispatched at a time for that queue;
- the next item is released only after the relevant Eve boundary;
- Telegram `update_id` remains the deduplication key;
- ambiguous post-dispatch crashes remain non-retryable where repeating model cost or side effects
  would be unsafe.

Separate task sessions do not permit unordered delivery into one canonical session. They only keep
parked workflows resumable while ordinary room conversation continues.

## Rotation and retention

Canonical rotation preserves the logical group/topic thread while creating a fresh Eve generation.
Existing limits for compaction, completed turns, and inactivity remain explicit configuration.

Task sessions follow a stricter lifecycle:

- a pending operation prevents retirement;
- completion or terminal failure clears the pending state;
- a completed non-pending task is retired promptly;
- abandoned non-pending tasks are retired by a scheduled sweep;
- a bounded per-group task count prevents unbounded accumulation;
- retired Eve workflow state is physically deleted through the existing leased retention job;
- retention holds continue to prevent deletion where explicitly required.

An old Telegram reply anchor may identify historical ancestry, but it must not revive stale model or
authorization state. After retirement it routes into the current canonical conversation with safe
reply ancestry, unless it is the exact continuation for a still-pending task.

## Migration

Migration `042` from per-message branches preserves data and avoids replay:

1. Deploy schema and routing support without changing live continuation ownership.
2. Reclassify pending group branches as tasks in place.
3. Mark old non-pending group branches as retired.
4. Keep exact routes only for still-pending task sessions.
5. Resolve ordinary historical replies through timeline ancestry into the canonical route.
6. Lazily create exactly one canonical generation per registered group/topic on its next addressed
   turn and bootstrap it from the PostgreSQL timeline; never concatenate old Eve histories or
   summaries.
7. Let the existing retention worker delete retired workflow state after the configured period.
8. Record audit events for promotion, canonical replacement, retirement, and cleanup.

Migration must be idempotent and safe under concurrent Telegram delivery. Advisory locks and DB
constraints must serialize canonical replacement with group removal and trust-zone recreation.

## External group type audit

### Pre-consolidation behavior

Before migration `041`, `external_private` and `external_public` had identical runtime behavior.

Both types:

- accept the same Telegram participants;
- receive only their own `group` memory scope;
- use the same external prompt and capability allowlist;
- use the same isolated group workspace and sandbox restrictions;
- have the same media, voice, history, HITL, web, and owner-only policies;
- are not checked against Telegram username, invite link, visibility, join policy, or membership
  configuration.

The only current differences are the persisted enum value, TypeScript type, and owner-visible label.
Changing between the two values is treated as a trust-zone type change and deletes group-scoped data,
despite producing no authorization or capability change. This distinction is misleading and should
not remain as an accidental persisted contract.

### Implemented consolidation

Migration `041` replaces `external_private` and `external_public` with one application type:

```text
external
```

Telegram itself determines whether the room is publicly discoverable or privately joined. Osinara's
security boundary is the registered external group ID and its persisted policy, not Telegram's
marketing/visibility classification.

The consolidation must be a data-preserving migration:

- convert both existing enum values to `external` in place;
- preserve group IDs, timeline, memory, workspace, sessions, routes, allowlists, and message mode;
- do not invoke trust-zone replacement or deletion cascades;
- simplify TypeScript unions, SQL predicates, registration input, approval text, tests, and prompts;
- keep `family_private` distinct because it has materially different membership, memory, workspace,
  credentials, and tool policies.

If the product later needs a private external mode, it must have an explicit application-enforced
participant allowlist or invitation model. A label that merely mirrors Telegram visibility is not an
authorization boundary.

## Required verification

Implementation is complete only when tests prove:

- one active canonical session per group/topic under concurrent delivery;
- ordinary mentions, commands, and replies reuse the canonical session;
- verified forum topics remain isolated;
- a parked canonical session is atomically promoted to task;
- unrelated participants continue through a replacement canonical session;
- only the requester can resume a task approval or free-form request;
- task completion enters the shared timeline exactly once;
- family and external auth scopes remain isolated on every turn and resume;
- policy and membership revocation remain fail-closed;
- migration preserves all existing group-owned data;
- stale reply aliases cannot revive retired authorization or model state;
- scheduled retirement and physical deletion are bounded, leased, and idempotent;
- Docker Compose integration covers PostgreSQL, Eve build artifacts, ingress ordering, and restart
  recovery.
