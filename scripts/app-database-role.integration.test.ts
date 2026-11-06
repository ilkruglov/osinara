/**
 * The application role against the migrated Compose test database.
 *
 * Constructs covered:
 * - `provisionAppDatabaseRole` creates the role and, run again, updates its password.
 * - The role reads and changes rows of application tables, and cannot create, alter, drop or
 *   truncate them, nor touch the migration ledger.
 * - Provisioning is one transaction: while it runs (or after it dies), the role never holds the
 *   grant on all tables without the ledger's revoke (Codex review, 6 November 2026: a connection
 *   of the running agent could write the ledger in that window and make a release skip a migration).
 */
import { randomBytes } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { APP_DATABASE_ROLE, provisionAppDatabaseRole, requireAppDatabaseConfig } from "./app-database-role.ts";

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true" || !process.env.DATABASE_URL)("app database role", () => {
  it("can change rows and nothing else", async () => {
    const adminUrl = process.env.DATABASE_URL as string;
    const appUrl = new URL(adminUrl);
    appUrl.username = APP_DATABASE_ROLE;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      appUrl.password = randomBytes(24).toString("base64url");
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
      // A second run is the next release: the password is reconciled, the grants re-applied.
      appUrl.password = randomBytes(24).toString("base64url");
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
    } finally {
      await admin.end();
    }

    const app = new pg.Client({ connectionString: appUrl.href });
    await app.connect();
    try {
      await expect(app.query("SELECT count(*) FROM users")).resolves.toBeDefined();
      await app.query("BEGIN");
      await expect(app.query("UPDATE users SET id = id WHERE false")).resolves.toBeDefined();
      await expect(app.query("DELETE FROM families WHERE false")).resolves.toBeDefined();
      await app.query("ROLLBACK");

      for (const statement of [
        "CREATE TABLE app_role_probe (id int)",
        "ALTER TABLE users ADD COLUMN app_role_probe int",
        "DROP TABLE users",
        "TRUNCATE families",
        "SELECT count(*) FROM schema_migrations",
        "INSERT INTO schema_migrations (name) VALUES ('999_app_role_probe.sql')",
      ]) {
        await expect(app.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await app.end();
    }
  });

  it("never shows the role the ledger between the grant on all tables and its revoke", async () => {
    const adminUrl = process.env.DATABASE_URL as string;
    const appUrl = new URL(adminUrl);
    appUrl.username = APP_DATABASE_ROLE;
    appUrl.password = randomBytes(24).toString("base64url");
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    // The running agent of the previous release, connected with the password it knows.
    let app: pg.Client | null = null;
    try {
      await provisionAppDatabaseRole(admin, requireAppDatabaseConfig(adminUrl, appUrl.href));
      app = new pg.Client({ connectionString: appUrl.href });
      await app.connect();
      const running = app;
      let seenInWindow: unknown = "not reached";
      const paused = {
        async query(text: string, values?: readonly unknown[]) {
          if (text.startsWith("REVOKE ALL ON schema_migrations")) {
            seenInWindow = await running.query("SELECT count(*) FROM schema_migrations").then(() => "readable", (error: { code?: string }) => error.code);
          }
          return admin.query(text, values as unknown[]);
        },
      };
      const next = new URL(appUrl.href);
      next.password = randomBytes(24).toString("base64url");
      await provisionAppDatabaseRole(paused, requireAppDatabaseConfig(adminUrl, next.href));

      expect(seenInWindow).toBe("42501");
    } finally {
      await app?.end();
      await admin.end();
    }
  });
});
