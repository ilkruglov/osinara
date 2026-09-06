import type Docker from "dockerode";
import type { SkillSyncRequest, SkillSyncResult } from "../../agent/lib/sandbox-runner/skill-sync-contract.js";
import { executeSandboxProcess } from "./docker-sandbox-process.js";
import { SKILL_SYNC_PROGRAM } from "./skill-sync-program.js";

export async function syncSkillFiles(docker: Docker, container: Docker.Container, request: SkillSyncRequest): Promise<SkillSyncResult> {
  const command = "node -e '" + SKILL_SYNC_PROGRAM.replaceAll("'", "'\\''") + "'";
  const result = await executeSandboxProcess(docker, container, {
    command, stdin: Buffer.from(JSON.stringify(request)), timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`AGENT_SANDBOX_RUNNER_SKILLS_SYNC_FAILED: ${result.stderr}`);
  const value = JSON.parse(result.stdout) as SkillSyncResult;
  if (![value.checked, value.written, value.removed].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_RESPONSE_INVALID: Missing synchronization result");
  }
  return value;
}
