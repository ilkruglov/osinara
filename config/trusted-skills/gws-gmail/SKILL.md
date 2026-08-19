---
name: gws-gmail
description: "Gmail: Send, read, and manage email."
metadata:
  version: "0.22.5"
  openclaw: "category=productivity;requires=bins:gws"
  cliHelp: "gws gmail --help"
---

# gmail (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, stop and report `AGENT_GOOGLE_WORKSPACE_SKILL_PACKAGE_INVALID`; never generate skills at runtime.

```bash
gws gmail <resource> <method> [flags]
```

## Helper Commands

| Command | Description |
|---------|-------------|
| [`+send`](../gws-gmail-send/SKILL.md) | Send an email |
| [`+triage`](../gws-gmail-triage/SKILL.md) | Show unread inbox summary (sender, subject, date) |
| [`+reply`](../gws-gmail-reply/SKILL.md) | Reply to a message (handles threading automatically) |
| [`+reply-all`](../gws-gmail-reply-all/SKILL.md) | Reply-all to a message (handles threading automatically) |
| [`+forward`](../gws-gmail-forward/SKILL.md) | Forward a message to new recipients |
| [`+read`](../gws-gmail-read/SKILL.md) | Read a message and extract its body or headers |
| [`+watch`](../gws-gmail-watch/SKILL.md) | Pull one bounded batch of new emails |

## API Resources

### users

  - `getProfile` — Gets the current user's Gmail profile.
  - `stop` — Stop receiving push notifications for the given user mailbox.
  - `watch` — Set up or update a push notification watch on the given user mailbox.
  - `drafts` — Operations on the 'drafts' resource
  - `history` — Operations on the 'history' resource
  - `labels` — Operations on the 'labels' resource
  - `messages` — Operations on the 'messages' resource
  - `settings` — Operations on the 'settings' resource
  - `threads` — Operations on the 'threads' resource

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws gmail --help

# Inspect a method's required params, types, and defaults
gws schema gmail.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.

## Message mutations through Osinara

Pass each API resource and method as a separate `argv` entry. Do not combine resource and
method segments such as `users.messages.trash`, and do not put `schema` after `gmail`.
Schema discovery is a top-level command:

```json
["schema", "gmail.users.messages.trash"]
```

Use these exact command shapes with `execute_google_workspace`:

```json
["gmail", "users", "messages", "trash", "--params", "{\"userId\":\"me\",\"id\":\"MESSAGE_ID\"}"]
["gmail", "users", "messages", "delete", "--params", "{\"userId\":\"me\",\"id\":\"MESSAGE_ID\"}"]
["gmail", "users", "messages", "modify", "--params", "{\"userId\":\"me\",\"id\":\"MESSAGE_ID\"}", "--json", "{\"removeLabelIds\":[\"UNREAD\"]}"]
```

`trash` is recoverable; `delete` permanently deletes the message. Mark a message read by removing
the `UNREAD` label in `--json`; `READ` is not a Gmail system label. URI identifiers belong in
`--params`, while label changes belong in `--json`. These mutations are supported and trigger
automatic Eve HITL. A command-forbidden result means the `argv` shape is outside the reviewed
allowlist; it does not prove that the Google profile is read-only or lacks an OAuth scope.
