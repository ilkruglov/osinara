/**
 * Eve dynamic-skill runtime-revision patch tests.
 *
 * Existing durable sessions must discard pre-deploy dynamic skill manifests
 * and resolve the current session-scoped packages exactly once per build.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineSkill } from "eve/skills";
import { describe, expect, it, vi } from "vitest";

import { codeShape } from "./vendored-code.js";

async function importEveModule(path: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
}

describe("Eve dynamic skill runtime revision patch", () => {
  it("refreshes only resumed-session skills inside the managed sandbox scope", async () => {
    const [keys, lifecycle, workflow] = await Promise.all([
      readFile("vendor/eve/dist/src/context/keys.js", "utf8"),
      readFile("vendor/eve/dist/src/context/dynamic-skill-lifecycle.js", "utf8"),
      readFile("vendor/eve/dist/src/execution/workflow-steps.js", "utf8"),
    ]);

    expect(codeShape(keys)).toContain(codeShape("eve.sessionDynamicSkillRuntimeRevision"));
    expect(codeShape(lifecycle)).toContain(codeShape("async function refreshDynamicSessionSkillsForRuntimeRevision"));
    expect(codeShape(workflow)).toContain(codeShape("refreshDynamicSessionSkillsForRuntimeRevision({ctx:c,resolvers:C"));
    const shape = codeShape(workflow);
    const at = (snippet: string) => shape.indexOf(codeShape(snippet));
    const revisionAssignment = at(
      "runtimeRevision=t;if(!v.sessionStarted)c.set(SessionDynamicSkillRuntimeRevisionKey,t)",
    );
    const managedScope = at("j=await runStep(c,g,async e=>{");
    const skillRefresh = at("refreshDynamicSessionSkillsForRuntimeRevision({ctx:c,resolvers:C");
    const turnPreparation = at("let t=resolveEffectiveOutputSchema(");

    expect(revisionAssignment).toBeGreaterThanOrEqual(0);
    expect(revisionAssignment).toBeLessThan(managedScope);
    expect(managedScope).toBeGreaterThanOrEqual(0);
    expect(shape.slice(managedScope, skillRefresh)).toContain(codeShape("v.sessionStarted&&await "));
    expect(skillRefresh).toBeGreaterThan(managedScope);
    expect(skillRefresh).toBeLessThan(turnPreparation);
  });

  it("replaces a legacy manifest once before the first turn of a new runtime", async () => {
    const [{ ContextContainer }, keys, lifecycle] = await Promise.all([
      importEveModule("vendor/eve/dist/src/context/container.js"),
      importEveModule("vendor/eve/dist/src/context/keys.js"),
      importEveModule("vendor/eve/dist/src/context/dynamic-skill-lifecycle.js"),
    ]) as [
      { ContextContainer: new () => {
        get(key: unknown): unknown;
        set(key: unknown, value: unknown): unknown;
      } },
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const refresh = lifecycle.refreshDynamicSessionSkillsForRuntimeRevision as
      | ((input: Record<string, unknown>) => Promise<void>)
      | undefined;
    expect(refresh).toBeTypeOf("function");

    const removePath = vi.fn(async () => undefined);
    const writeBinaryFile = vi.fn(async () => undefined);
    const sandbox = {
      removePath,
      run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "/home/eve\n" })),
      writeBinaryFile,
    };
    const ctx = new ContextContainer();
    ctx.set(keys.SandboxKey, { get: async () => sandbox });
    ctx.set(keys.DynamicSkillManifestKey, {
      scoped: [
        { description: "Removed package", name: "pohuy" },
        { description: "Old package", name: "gws" },
      ],
    });
    const resolver = {
      eventNames: ["session.started"],
      events: {
        "session.started": () => ({
          gws: defineSkill({ description: "Current package", markdown: "# Current" }),
        }),
      },
      logicalPath: "agent/skills/scoped.ts",
      slug: "scoped",
      sourceId: "agent/skills/scoped.ts",
      sourceKind: "module",
    };
    const input = {
      ctx,
      event: { data: {}, type: "session.started" },
      messages: [],
      resolvers: [resolver],
      runtimeRevision: "runtime-new",
    };

    await refresh!(input);

    expect(removePath).toHaveBeenCalledTimes(2);
    expect(removePath).toHaveBeenCalledWith({
      force: true,
      path: "/home/eve/.agents/skills/pohuy",
      recursive: true,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "/home/eve/.agents/skills/gws/SKILL.md",
    }));
    expect(ctx.get(keys.DynamicSkillManifestKey)).toEqual({
      scoped: [{ description: "Current package", name: "gws" }],
    });
    expect(ctx.get(keys.SessionDynamicSkillRuntimeRevisionKey)).toBe("runtime-new");

    const writesAfterRefresh = writeBinaryFile.mock.calls.length;
    await refresh!(input);
    expect(removePath).toHaveBeenCalledTimes(2);
    expect(writeBinaryFile).toHaveBeenCalledTimes(writesAfterRefresh);
  });
});
