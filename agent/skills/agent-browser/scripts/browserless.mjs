// Run from the materialized skill package; uses Node built-ins only in the sandbox image.
import { fork, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BRIDGE_PORT, startBridge } from "./browserless-bridge.mjs";

const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const SELF = fileURLToPath(import.meta.url);
const COMMANDS = new Set(["open", "read", "snapshot", "screenshot", "click", "fill", "type", "press", "scroll", "wait", "get", "tab", "back", "forward", "reload", "select", "check", "uncheck", "hover"]);

export function browserEnvironment(source) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith("AGENT_BROWSER_") && !key.startsWith("BROWSERLESS_")
  ));
  return {
    ...env, HOME: "/tmp/osinara-browserless-home", AGENT_BROWSER_SESSION: "osinara-cloud",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000",
  };
}

async function status() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1_000) });
    const data = await res.json();
    return data.service === "osinara-browserless" ? data : null;
  } catch { return null; }
}

async function start() {
  await new Promise((resolve, reject) => {
    const child = fork(SELF, ["serve"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => finish(new Error("AGENT_BROWSERLESS_START_TIMEOUT")), 5_000);
    function finish(error) {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error); else resolve();
    }
    child.once("message", (message) => finish(message.ready ? undefined : new Error("AGENT_BROWSERLESS_START_FAILED")));
    child.once("error", () => finish(new Error("AGENT_BROWSERLESS_START_FAILED")));
  });
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (command === "serve") {
    try {
      await startBridge({ apiKey: process.env.BROWSERLESS_API_KEY });
      process.send?.({ ready: true });
    } catch { process.send?.({ ready: false }); process.exitCode = 1; }
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify({ configured: Boolean(process.env.BROWSERLESS_API_KEY?.trim()), session: await status() }));
    return;
  }
  if (command === "close") {
    if (await status()) await fetch(`${BASE}/close`, { method: "POST", signal: AbortSignal.timeout(1_000) });
    console.log("Browserless session closed");
    return;
  }
  if (!COMMANDS.has(command) || args.some((arg) => /^--(?:session|profile|state|restore|provider|cdp|config)(?:=|$)/u.test(arg) || arg === "-p")) {
    throw new Error("AGENT_BROWSERLESS_COMMAND_FORBIDDEN: Используйте open, read, snapshot или действия на странице");
  }
  if (!process.env.BROWSERLESS_API_KEY?.trim()) {
    throw new Error("AGENT_BROWSERLESS_NOT_CONFIGURED: Не задан BROWSERLESS_API_KEY");
  }
  if (!(await status())) {
    if (command !== "open") throw new Error("AGENT_BROWSERLESS_SESSION_EXPIRED: Сессия завершена; начните новую через open");
    await start();
  }
  const env = browserEnvironment(process.env);
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  // An empty working directory prevents loading the local browser's project config.
  const child = spawn("agent-browser", ["--cdp", `ws://127.0.0.1:${BRIDGE_PORT}/cdp`, command, ...args], {
    cwd: env.HOME, env, stdio: "inherit",
  });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const timer = setTimeout(terminate, 40_000);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => reject(new Error("AGENT_BROWSERLESS_CLI_FAILED")));
    });
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // All errors authored here are token-free; never print transport errors or provider URLs.
    console.error(error.message?.startsWith("AGENT_BROWSERLESS_") ? error.message : "AGENT_BROWSERLESS_FAILED");
    process.exitCode = 1;
  });
}
