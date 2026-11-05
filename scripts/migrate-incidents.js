const { Pool } = require("pg");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function incidentPool() {
  if (!process.env.DATABASE_URL) throw new Error("database_not_configured");
  const url = new URL(process.env.DATABASE_URL),
    host = url.hostname;
  const encoded = process.env.CHAT_DB_CA_BASE64;
  if (
    (process.env.NODE_ENV === "production" || host.endsWith(".supabase.com")) &&
    !encoded
  )
    throw new Error("database_ca_required");
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(name);
  const ssl = encoded
    ? {
        ca: Buffer.from(encoded, "base64").toString(),
        rejectUnauthorized: true,
        servername: host,
      }
    : undefined;
  if (ssl && !ssl.ca.includes("BEGIN CERTIFICATE"))
    throw new Error("database_ca_invalid");
  return new Pool({
    connectionString: url.toString(),
    ssl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
}
async function preflight(client) {
  const {
    rows: [r],
  } =
    await client.query(`SELECT to_regclass('public.reports') IS NOT NULL AS reports,to_regclass('public.users') IS NOT NULL AS users,
    to_regclass('private_incidents.incidents') IS NOT NULL AS incidents,EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS postgis`);
  if (!r.reports || !r.users) throw new Error("existing_schema_required");
  return r;
}
async function applyIncidentMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(20261101)");
    await preflight(client);
    await client.query(
      readFileSync(
        path.join(__dirname, "../db/migrations/20261101_incidents.sql"),
        "utf8",
      ),
    );
    await client.query(readFileSync(path.join(__dirname, "../db/migrations/20261106_incident_intelligence.sql"), "utf8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function main() {
  const pool = incidentPool();
  try {
    if (process.argv.includes("--apply")) {
      await applyIncidentMigrations(pool);
      console.log("Incident migration applied");
    }
    console.log(JSON.stringify(await preflight(pool)));
  } finally {
    await pool.end();
  }
}
module.exports = { incidentPool, preflight, applyIncidentMigrations };
if (require.main === module)
  main().catch(() => {
    console.error(
      "Incident preflight/migration failed; check database access and schema privileges.",
    );
    process.exitCode = 1;
  });
