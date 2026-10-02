/**
 * Bounded wait for the agent server to become healthy after a container start.
 *
 * Exports:
 * - `watchStartup`: polls the health route until it answers, the server process is gone, or the
 *   deadline passes; at the deadline it sends SIGTERM, then SIGKILL after a grace period.
 *
 * Key construct:
 * - `eve start` used to wait up to five minutes for health and exit when it never came, so Docker
 *   restarted the container. The entrypoint now runs the built server directly (1.8.12), which
 *   dropped that wait: a server alive but never ready would stay `unhealthy`, and
 *   `restart: unless-stopped` only reacts to an exit (Codex review, 3 October 2026). The
 *   entrypoint starts this script in the background right before `exec`, so its parent process
 *   becomes the server; it exits as soon as health answers and holds no memory after start.
 */
import { setTimeout as sleep } from "node:timers/promises";

export interface StartupWatch {
  deadlineMs: number;
  healthUrl: string;
  killAfterMs: number;
  pollMs: number;
  serverPid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function watchStartup(
  watch: StartupWatch,
): Promise<"healthy" | "server-gone" | "stopped"> {
  const deadline = Date.now() + watch.deadlineMs;
  while (Date.now() < deadline) {
    if (!alive(watch.serverPid)) return "server-gone";
    if (await healthy(watch.healthUrl, Math.max(1, Math.min(2_000, deadline - Date.now())))) {
      return "healthy";
    }
    await sleep(watch.pollMs);
  }
  if (!alive(watch.serverPid)) return "server-gone";
  console.error(JSON.stringify({
    code: "AGENT_STARTUP_HEALTH_TIMEOUT",
    deadlineMs: watch.deadlineMs,
    message: "The agent server never answered health; stopping it so the container restarts",
  }));
  process.kill(watch.serverPid, "SIGTERM");
  const killAt = Date.now() + watch.killAfterMs;
  while (Date.now() < killAt) {
    if (!alive(watch.serverPid)) return "stopped";
    await sleep(Math.min(watch.pollMs, 250));
  }
  if (alive(watch.serverPid)) process.kill(watch.serverPid, "SIGKILL");
  return "stopped";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await watchStartup({
    // Matches Eve's own start timeout as patched for first-start sandbox preparation.
    deadlineMs: 5 * 60 * 1_000,
    healthUrl: `http://127.0.0.1:${process.env.PORT ?? "3000"}/eve/v1/health`,
    killAfterMs: 30_000,
    pollMs: 2_000,
    serverPid: process.ppid,
  });
}
