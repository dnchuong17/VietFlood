const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { Pool } = require("pg");

function keyring() {
  const active = process.env.CHAT_KEY_CURRENT;
  const encoded = process.env.CHAT_KEYRING_B64;
  if (!active || !encoded) throw new Error("Chat keys are not configured");
  const values = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const keys = new Map();
  for (const [id, value] of Object.entries(values)) {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64") !== value)
      throw new Error("Chat keyring is invalid");
    keys.set(id, key);
  }
  if (!keys.has(active)) throw new Error("Active chat key is unavailable");
  return { active, keys };
}

function aad(row) {
  return Buffer.from(JSON.stringify([row.user_id, row.session_id, row.id, row.role]));
}

async function main() {
  const { active, keys } = keyring();
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
  let rotated = 0;
  try {
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT m.id, m.session_id, m.role, m.ciphertext, m.nonce, m.auth_tag,
                  m.key_id, s.user_id
           FROM private_chat.messages m
           JOIN private_chat.sessions s ON s.id = m.session_id
           WHERE m.key_id <> $1
           ORDER BY m.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED`,
          [active],
        );
        if (result.rows.length === 0) {
          await client.query("COMMIT");
          break;
        }
        for (const row of result.rows) {
          const oldKey = keys.get(row.key_id);
          if (!oldKey) throw new Error("An old chat key is unavailable");
          const decipher = createDecipheriv("aes-256-gcm", oldKey, row.nonce);
          decipher.setAAD(aad(row));
          decipher.setAuthTag(row.auth_tag);
          const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", keys.get(active), nonce);
          cipher.setAAD(aad(row));
          const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          plaintext.fill(0);
          await client.query(
            `UPDATE private_chat.messages SET ciphertext = $2, nonce = $3,
                    auth_tag = $4, key_id = $5 WHERE id = $1`,
            [row.id, ciphertext, nonce, cipher.getAuthTag(), active],
          );
          rotated++;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  process.stdout.write(`Rotated ${rotated} chat messages\n`);
}

main().catch(() => {
  process.stderr.write("Chat key rotation failed; keep all old keys configured\n");
  process.exitCode = 1;
});
