// Run from the materialized skill package; uses Node built-ins only in the sandbox image.
//
// agent-browser 0.36 does not send its WebSocket through an HTTP proxy, so it connects straight
// to the egress proxy's own Browserless endpoint; the proxy adds the key, which never enters the
// sandbox, and keeps one cloud session per sandbox. There is no local bridge process any more:
// the runner ends whatever a command leaves running, the bridge included, and the next command of
// the same cloud session found it gone (Codex review, 5 October 2026). The session's deadline
// lives in a file in the helper's HOME with a one-time session id: the proxy opens a cloud browser
// once per id, so when agent-browser reconnects on its own after a dropped WebSocket it is refused
// instead of quietly starting another billable browser; only `open` makes a new id.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HOME = "/tmp/osinara-browserless-home";
const SESSION_FILE = `${HOME}/session.json`;
const LIFETIME_MS = 120_000;
// Reading only: an action on a page goes through browser_act, whose gate asks before a form is sent.
const COMMANDS = new Set(["open", "read", "snapshot", "screenshot", "scroll", "wait", "get", "tab", "back", "forward", "reload"]);

/** The proxy's Browserless endpoint, from the sandbox's proxy address; no key, fixed parameters. */
export function cloudEndpoint(proxyUrl, sessionId) {
  let proxy;
  try {
    proxy = new URL(proxyUrl ?? "");
  } catch {
    throw new Error("AGENT_BROWSERLESS_PROXY_INVALID");
  }
  if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search) {
    throw new Error("AGENT_BROWSERLESS_PROXY_INVALID");
  }
  if (!/^[0-9a-f]{32}$/u.test(sessionId ?? "")) throw new Error("AGENT_BROWSERLESS_SESSION_INVALID");
  const query = new URLSearchParams({ session: sessionId, solveCaptchas: "true", timeout: String(LIFETIME_MS) });
  return `ws://${proxy.host}/browserless/chromium/stealth?${query}`;
}

export function browserEnvironment(source) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith("AGENT_BROWSER_") && !key.startsWith("BROWSERLESS_")
  ));
  return {
    ...env, HOME, AGENT_BROWSER_SESSION: "osinara-cloud",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000",
  };
}

async function liveSession(now = Date.now()) {
  try {
    const session = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    return typeof session.expiresAt === "number" && session.expiresAt > now && typeof session.id === "string" ? session : null;
  } catch { return null; }
}

async function runAgentBrowser(args, env) {
  // An empty working directory prevents loading the local browser's project config.
  const child = spawn("agent-browser", args, { cwd: env.HOME, env, stdio: "inherit" });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const timer = setTimeout(terminate, 40_000);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    return await new Promise((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => reject(new Error("AGENT_BROWSERLESS_CLI_FAILED")));
    });
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}

export async function main(argv) {
  const [command, ...args] = argv;
  const env = browserEnvironment(process.env);
  if (command === "status") {
    console.log(JSON.stringify({ configured: process.env.BROWSERLESS_AVAILABLE === "true", session: await liveSession() }));
    return;
  }
  if (command === "close") {
    if (await liveSession()) await runAgentBrowser(["close"], env).catch(() => 1);
    await rm(SESSION_FILE, { force: true });
    console.log("Browserless session closed");
    return;
  }
  if (!COMMANDS.has(command) || args.some((arg) => /^--(?:session|profile|state|restore|provider|cdp|config)(?:=|$)/u.test(arg) || arg === "-p")) {
    throw new Error("AGENT_BROWSERLESS_COMMAND_FORBIDDEN: Облачный браузер только читает: open, read, snapshot, screenshot, scroll, get. Действия на странице делает browser_act");
  }
  if (process.env.BROWSERLESS_AVAILABLE !== "true") {
    throw new Error("AGENT_BROWSERLESS_NOT_CONFIGURED: Облачный браузер не подключён");
  }
  const live = await liveSession();
  if (!live && command !== "open") {
    throw new Error("AGENT_BROWSERLESS_SESSION_EXPIRED: Сессия завершена; начните новую через open");
  }
  const id = live?.id ?? randomBytes(16).toString("hex");
  const endpoint = cloudEndpoint(process.env.HTTPS_PROXY, id);
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const code = await runAgentBrowser(["--cdp", endpoint, command, ...args], env);
  // The cloud session starts with the first open that succeeds and ends with the proxy's deadline.
  if (!live && code === 0) await writeFile(SESSION_FILE, JSON.stringify({ expiresAt: startedAt + LIFETIME_MS, id }), { mode: 0o600 });
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // All errors authored here are token-free; never print transport errors or provider URLs.
    console.error(error.message?.startsWith("AGENT_BROWSERLESS_") ? error.message : "AGENT_BROWSERLESS_FAILED");
    process.exitCode = 1;
  });
}
