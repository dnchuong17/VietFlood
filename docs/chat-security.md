# Chat security and operations

## Architecture

The gateway authenticates the existing custom JWT and uses its verified `sub`
as the database user ID. The `pg` repository scopes list, read, append, and
delete SQL by that ID. `POST /chat` keeps its existing cross-user `403` response;
history read and delete routes return `404` for missing and foreign sessions.
Every successful message pair is inserted in one transaction. PostgreSQL
foreign keys cascade message deletion when a session or account is deleted.
Legacy import and deletion take the same per-session PostgreSQL advisory lock,
so a deleted Redis conversation cannot be imported afterward.

`db/migrations/20261009_chat_history.sql` creates `private_chat.sessions` and
`private_chat.messages` with indexes and stable per-session sequence numbers.
The migration enables and forces RLS, revokes access from Supabase API roles,
and adds no client policies. **RLS does not provide per-user isolation for the
postgres-derived backend role**, which can bypass it. Keep the tables out of
the exposed Supabase API schemas and retain the SQL ownership predicates.
Never expose `DATABASE_URL` or any privileged Supabase credential to a client.

Message content is stored as AES-256-GCM ciphertext, random nonce, tag, and key
version. Authenticated associated data binds the user ID, session ID, message
ID, and role. Titles are derived from decrypted first messages on read; there
is no plaintext title or preview column. The hosting provider's encryption at
rest and controlled, encrypted backups are still required. Chat responses are
marked `Cache-Control: private, no-store` on history routes.

## Configuration and deployment

Set these server-side environment variables in Jenkins' protected
`/opt/env/vietflood.env` or a dedicated secret store:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL connection for the backend role. |
| `CHAT_DB_CA_BASE64` | Base64-encoded Supabase CA PEM certificate. TLS certificate and hostname verification are mandatory in production. |
| `CHAT_KEYRING_B64` | Base64-encoded JSON object mapping key versions to base64-encoded 32-byte keys. |
| `CHAT_KEY_CURRENT` | Version used for newly encrypted messages, e.g. `v1`. |
| `CHAT_HISTORY_ENABLED` | Set to `false` during restore to make all chat routes return `503`; defaults to enabled. |
| `CHAT_BACKUP_RETENTION_DAYS` | Actual verified backup/PITR retention in days, recorded before release. |
| `CHAT_BACKUP_VERIFIED_AT` | Date the plan, backup encryption, and access permissions were checked. |
| `QDRANT_URL`, `QDRANT_COLLECTION`, `QDRANT_TEXT_FIELD` | Local flood knowledge retrieval; current field is `text`. |

Generate a 32-byte key with a cryptographically secure random generator. Keep
the unencoded key and the encoded keyring in the secret store; base64 is only
an encoding. Never commit keys or print them in deployment logs. Obtain the
Supabase CA from the project's database connection settings, verify its
fingerprint, then encode the PEM into `CHAT_DB_CA_BASE64`. Enable Supabase SSL
enforcement. The `pg` client verifies the certificate and server hostname;
startup checks database access before accepting requests. The gateway relies
on the existing HTTPS reverse proxy and its HSTS configuration; verify both
in the deployed environment.

Jenkins builds the image and runs the idempotent migration **before** stopping
the old container. Its preflight requires the chat keys, CA, and recorded
backup values. With a non-Jenkins deployment, run the migration from the
gateway image on the same network before starting the new gateway:

```sh
docker run --rm --network <app-network> --env-file <protected-env-file> \
  --entrypoint node <gateway-image> /app/scripts/migrate-chat-history.js
```

Do not use the production database for integration tests. Set
`CHAT_TEST_DATABASE_URL` to a disposable PostgreSQL database and
`CHAT_TEST_DATABASE_ISOLATED=YES` to run the gated repository integration
suite. It creates and drops its own `private_chat` schema. Use
`npm test -- --run apps/api-gateway/src/chat` for the chat suite.

## Key rotation

Add the new key under a new version to `CHAT_KEYRING_B64`, keep the previous
keys, and set `CHAT_KEY_CURRENT` to the new version. Deploy this configuration,
then run the batch re-encryption script with the same protected environment:

```sh
docker run --rm --network <app-network> --env-file <protected-env-file> \
  --entrypoint node <gateway-image> /app/scripts/rotate-chat-history-key.js
```

Verify that no `private_chat.messages` row references an old `key_id` before
removing that key. Retain old keys while any recoverable backup still contains
messages encrypted with them. Rotation updates messages in short transactions;
the script is safe to rerun.

## Data, retention, and third parties

Active PostgreSQL chat history is retained until the user hard-deletes the
session or account. Deletion immediately removes the session and cascading
messages from the live database. There is no soft deletion. Legacy Redis
sessions have a 24-hour TTL; a still-active session is imported and the
plaintext Redis copy removed when the owner reopens it. Expired Redis content
is unrecoverable. Redis retains the per-user rate-limit key for about two
minutes. Report-status replies can be stored in history, but are excluded from
any future model context.

**The current chatbot sends no user messages, account data, report data, or
staging Qdrant passages to Gemini.** Flood answers use local extractive
retrieval; first-aid and report guidance are local. If Gemini is approved for
a future production path, that change must explicitly review transmission of
the current user question, up to 10 eligible preceding chat messages, selected
knowledge passages, and the system prompt. Exclude report-status replies and
account data, obtain approval for staging passages, and document the provider's
retention settings before enabling it. Do not log chat content, JWTs, refresh
tokens, passwords, API keys, ciphertext keys, or raw database errors.

Before release, record the **actual** Supabase plan, daily backup and PITR
retention windows, encryption, and who can download/restore backups. The
Jenkins variables are a deployment gate, not proof that these settings are
correct. Deleted content can remain in retained backups until those backups
expire. No fixed deletion deadline is promised until the actual settings are
verified. Rotate the previously shared Gemini key and refresh token before
rollout.

## Restore runbook

1. Set `CHAT_HISTORY_ENABLED=false` in the runtime environment and restart or
   otherwise block all chat routes while recovery runs. Do not reopen chat on
   a restored snapshot yet.
2. Restore the database and identify every chat deletion and account deletion
   after the restore point. Reapply them if complete, trustworthy records are
   available.
3. This release has no external deletion ledger. If full reconciliation is
   impossible, purge **all** restored chat history with
   `TRUNCATE private_chat.sessions CASCADE;` while chat remains unavailable.
   Verify `private_chat.sessions` and `private_chat.messages` are empty.
4. Confirm database TLS, keys, migration, and ownership checks, then re-enable
   chat. Tell users if their history was purged. Apply normal backup expiry to
   the restored snapshot and restrict restore/download access.
