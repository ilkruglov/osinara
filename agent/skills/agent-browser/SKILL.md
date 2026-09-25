---
name: agent-browser
description: Manual Chromium in the sandbox through the agent-browser CLI. Use when a page needs JavaScript, a login, a form, clicks or a screenshot, or when browser_task returned blocked or failed or is not offered. Reading a known public page goes through web_fetch, finding pages through web_search.
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with
accessibility-tree snapshots and compact `@eN` element refs.

Install: `npm i -g agent-browser && agent-browser install`

## Runtime

**When to use.** A page needs JavaScript, a login, a form, a click, or a screenshot. **When not to use:** a public page that only has to be read — `web_fetch` returns its text in one call with no browser; `web_search` finds pages. Reach for the browser only after `web_fetch` failed or returned an empty or truncated page.

The runtime preconfigures `AGENT_BROWSER_SESSION=osinara`, `AGENT_BROWSER_RESTORE=osinara`, and a persistent scope-owned `$HOME`. Never set `AGENT_BROWSER_SESSION` yourself and never invent session names: every new name launches another Chromium (about 200 threads) inside a sandbox with a fixed thread budget, and the sandbox then stops running any command until it is reset. Each CLI invocation is only a client request to the same background daemon: separate Bash calls continue the same Chromium process, tabs, cookies, and authentication state. `batch` is optional and does not control persistence.

Rules that keep a turn short:

1. One browser command per Bash call, bounded as `timeout --signal=TERM --kill-after=5s 45s agent-browser ...`. Never chain `open`, `wait`, `snapshot` in one command and never hide output with `>/dev/null`: the exit code and the error text are the only way to see what happened.
2. After `open`, read the page with `snapshot -i -c` (interactive elements) or `read` (text). Both take a second. `wait --load networkidle` is optional and never needed for `read`.
3. A screenshot is for visual content only: a chart, a table rendered as an image, a captcha, a layout question. Save it straight into the workspace, `agent-browser screenshot /workspace/<scope>/shots/<name>.png`, and describe it with `inspect_workspace_image` (`scope`, `path: shots/<name>.png`). Vision costs about eight seconds and a second model; `snapshot` costs one second.
4. If `open` times out, run `agent-browser session info --json` once. Retry the same URL once only when the session check shows a startup or runtime transient; otherwise say which site did not answer and move on. The sandbox refuses a command that already timed out unchanged (`AGENT_SANDBOX_RUNNER_REPEAT_WITHOUT_PROGRESS`), so a third attempt is impossible by design.
5. A stuck session is recovered with `close --all` and a fresh `open` in the same `osinara` session, never with a new session name. Do not call `close` before the whole user task is done: a completed CLI process or a screenshot does not close Chromium, and the configured restore state reloads cookies and localStorage on the next `open` after a real sandbox recreation.
6. A site that shows only a login wall (LinkedIn, most social profiles) stays closed without credentials; say so instead of trying other URLs of the same site.
7. Reading and data extraction from public pages go through the light engine: `agent-browser --session osinara-reader --engine lightpanda open <url>`, then `read` or `snapshot` with the same two flags. It starts in a second, costs a twentieth of Chromium and keeps the pid budget for the real browser. It has no cookies, logins, profiles or screenshots, and some sites (VK) call it an outdated browser: for those, for forms, for logins and for screenshots use the default Chromium session `osinara`. These are the only local session names. The optional cloud helper below owns one separate session.

## Browserless fallback for blocked public pages

Keep the local browser as the default. When a public page shows a CAPTCHA or anti-bot block after a local attempt, use the optional Browserless helper. This is available only in trusted personal/family sandboxes. It creates an isolated cloud browser with automatic CAPTCHA solving; it never restores local cookies, passwords or profiles. Do not transfer credentials, private files or local browser state to it. Login walls still require the local authorized browser.

First check availability without printing environment variables or credentials:

```bash
node "$HOME/.agents/skills/agent-browser/scripts/browserless.mjs" status
```

If `configured` is false, stop this fallback and explain that Browserless has not been configured. Do not install another browser or ask for a token in the conversation.

Use one command per Bash call, keeping this helper for every cloud action:

```bash
timeout --signal=TERM --kill-after=5s 45s node "$HOME/.agents/skills/agent-browser/scripts/browserless.mjs" open https://example.com
```

```bash
timeout --signal=TERM --kill-after=5s 45s node "$HOME/.agents/skills/agent-browser/scripts/browserless.mjs" snapshot -i -c
```

The helper also supports `read`, `screenshot` (use an absolute workspace path), `click`, `fill`, `press`, `scroll`, `get` and other ordinary page actions. It owns `osinara-cloud` and routes CDP through the sandbox egress proxy. Never use `-p browserless`, override its session/profile/CDP flags, or build a provider URL containing the token yourself.

The entire cloud session lasts at most two minutes, including time between commands. CAPTCHA solving may take tens of seconds: use `wait 30000`, then inspect the page again. If it is still solving and the session has enough time left, allow one more `wait 30000` and inspection. A returned screenshot or successful navigation alone does not prove that the CAPTCHA is solved. If still blocked, the session expires, or the provider rejects the request, report that result. Do not loop, automatically reopen an expired session or retry a form submission. One cloud attempt per blocked site per user task is enough; further attempts require a new user request. Residential proxies are not enabled by this helper because their traffic consumes the free allowance quickly.

Close promptly after extracting the needed result, even if the task continues in the local browser:

```bash
node "$HOME/.agents/skills/agent-browser/scripts/browserless.mjs" close
```

## Start here

This file is a discovery stub, not the usage guide. Before running any
`agent-browser` command, load the actual workflow content from the CLI:

```bash
agent-browser skills get core             # start here — workflows, common patterns, troubleshooting
agent-browser skills get core --full      # include full command reference and templates
```

The CLI serves skill content that always matches the installed version,
so instructions never go stale. The content in this stub cannot change
between releases, which is why it just points at `skills get core`.

## Session and auth vault

The runtime runs `agent-browser` with `AGENT_BROWSER_SESSION=osinara`; separate calls continue the same tab. Do not close the session before the task is done, and check it with `agent-browser session info --json` before treating it as lost. Cookies and localStorage live in `$HOME`; when a site session has expired, use the vault first.

Persistent logins go into the `agent-browser auth vault` of the current trust zone (personal or family) through `--password-stdin`; never store OTP codes. Save an integration token only on the user's direct request and only when this skill allows the current scope: inside this skill's `$HOME`, mode `0600`, without printing or logging it.
