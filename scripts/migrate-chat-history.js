const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const caEncoded = process.env.CHAT_DB_CA_BASE64;
  if (!connectionString)
    throw new Error("Chat database connection or CA is not configured");
  const parsedUrl = new URL(connectionString);
  const host = parsedUrl.hostname;
  if ((process.env.NODE_ENV === "production" || host.endsWith(".supabase.com")) && !caEncoded)
    throw new Error("Chat database CA is required");
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) parsedUrl.searchParams.delete(name);
  const ssl = caEncoded
    ? { ca: Buffer.from(caEncoded, "base64").toString("utf8"), rejectUnauthorized: true, servername: host }
    : undefined;
  if (ssl && !ssl.ca.includes("BEGIN CERTIFICATE"))
    throw new Error("Chat database CA is invalid");
  const pool = new Pool({ connectionString: parsedUrl.toString(), ssl, max: 1 });
  const client = await pool.connect();
  try {
    const sql = readFileSync(path.join(__dirname, "../db/migrations/20261009_chat_history.sql"), "utf8");
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(20261009)");
    await client.query(sql);
    await client.query("COMMIT");
    process.stdout.write("Chat history migration applied\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write("Chat history migration failed; inspect database access and schema permissions\n");
  process.exitCode = 1;
});
