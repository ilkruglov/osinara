/**
 * Database migration runner.
 *
 * Constructs:
 * - Applies ordered SQL files once inside a PostgreSQL transaction; a data migration's `RAISE
 *   NOTICE` (what it changed) goes to the log with the migration's name once the migration
 *   committed, or marked rolled back (review, 23 November 2026: a count printed before a failed
 *   commit read as done). Notices outside a migration («already exists, skipping») are dropped.
 * - With APP_DATABASE_URL, then provisions the least-privilege role the application runs as.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import { provisionAppDatabaseRole, requireAppDatabaseConfig } from "./app-database-role.ts";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных");
}
// Production sets it; a development database keeps running as the owner.
const appDatabaseUrl = process.env.APP_DATABASE_URL;
const appDatabase = appDatabaseUrl ? requireAppDatabaseConfig(databaseUrl, appDatabaseUrl) : null;

const client = new Client({ connectionString: databaseUrl });
// The notices of the migration being applied; cleared before each one, so the ledger's own
// («already exists, skipping») and the role provisioning's are never printed.
const notices: string[] = [];
client.on("notice", (notice) => {
  notices.push(notice.message ?? "");
});
function reportNotices(migration: string, messages: readonly string[], rolledBack: boolean): void {
  for (const message of messages) {
    console.log(
      JSON.stringify({
        code: "MIGRATION_NOTICE",
        message,
        migration,
        ...(rolledBack ? { rolledBack: true } : {}),
      }),
    );
  }
}
await client.connect();

try {
  // The ledger must exist before the first authored migration creates the full schema.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Serialize replicas before they inspect the ledger, avoiding concurrent DDL application.
  await client.query("SELECT pg_advisory_lock(hashtextextended('osinara-schema-migrations', 0))");

  // Tests point the runner at their own files; the deploy never sets it.
  const directory = resolve(process.env.MIGRATIONS_DIRECTORY || "migrations");
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of migrations) {
    const applied = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists",
      [name],
    );
    if (applied.rows[0]?.exists) continue;

    // Each file is atomic; a failed statement leaves both schema and ledger unchanged.
    const sql = await readFile(resolve(directory, name), "utf8");
    notices.length = 0;
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      reportNotices(name, notices, false);
    } catch (error) {
      // Printed before the rollback, whose own warning after a failed COMMIT is not the
      // migration's; a failing rollback does not replace the migration's error.
      reportNotices(name, notices, true);
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  if (appDatabase) await provisionAppDatabaseRole(client, appDatabase);
} finally {
  await client.end();
}
