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

The deployment runner applies `20261009_chat_history.sql` followed by the
cumulative `20261009_chat_action_kind.sql`, which includes `small_talk`,
`community_reports`, and `action`. It skips the older intermediate kind
constraints so reruns also work with existing messages of those kinds.

Message content is stored as AES-256-GCM ciphertext, random nonce, tag, and key
version. Authenticated associated data binds the user ID, session ID, message
ID, and role. Titles are derived from decrypted first messages on read; there
is no plaintext title or preview column. The hosting provider's encryption at
rest and controlled, encrypted backups are still required. Chat responses are
marked `Cache-Control: private, no-store` on history routes.

## Configuration and deployment

If action replies fail with HTTP `503`, rebuild the image and rerun the Jenkins
deployment, including **Migrate Chat History**. Both Docker images include the
latest kind constraint. For other database failures, the gateway logs only the
error `code` and constraint identifier; `23514` with `messages_kind_check`
identifies a schema mismatch. It does not log database error messages or SQL
parameters. Idle connection errors are handled, failed rollback connections are
discarded, and the services retire idle sockets after ten seconds.

### One-time Jenkins environment checklist

The unified Jenkins image runs the gateway, auth service, and reports service.
Put these entries together in the protected `/opt/env/vietflood.env` on the
Jenkins agent. Use real values for placeholders; do not commit this file.

```ini
# Existing application services
DATABASE_URL=<Supabase PostgreSQL URL>
JWT_SECRET=<existing access-token signing secret>
REFRESH_SECRET=<existing refresh-token signing secret>
REDIS_PASSWORD=<Redis password>
RABBITMQ_DEFAULT_USER=<RabbitMQ username>
RABBITMQ_DEFAULT_PASS=<RabbitMQ password>
CLOUDINARY_CLOUD_NAME=<Cloudinary cloud name>
CLOUDINARY_API_KEY=<Cloudinary API key>
CLOUDINARY_API_SECRET=<Cloudinary API secret>
ADMIN_EMAIL=<admin email>
ADMIN_PASSWORD=<admin password>

# Persistent chat
CHAT_KEYRING_B64=<base64 of JSON mapping key versions to base64 32-byte keys>
CHAT_KEY_CURRENT=v1
CHAT_DB_CA_BASE64=<base64 of the Supabase root certificate PEM>
CHAT_HISTORY_ENABLED=true
CHAT_BACKUP_RETENTION_DAYS=7
CHAT_BACKUP_VERIFIED_AT=<YYYY-MM-DD after backup settings are checked>

# Flood knowledge
QDRANT_URL=https://qdrant.ndtd.indevs.in:443
QDRANT_COLLECTION=flood_kb_staging_2026_01
QDRANT_CHAT_COLLECTION=flood_kb_active
RAG_SERVICE_URL=http://rag-retrieval:8001
RAG_SERVICE_TOKEN=<shared internal-service secret>
QDRANT_TEXT_FIELD=text
OPENAI_API_KEY=<secret>
OPENAI_BASE_URL=https://cheapkeyai.shop/v1
OPENAI_CHAT_MODEL=gpt-4.1-nano-2025-04-14
OPENAI_REQUEST_TIMEOUT_MS=120000
RAG_REQUEST_TIMEOUT_MS=300000
RAG_RETRIEVAL_TIMEOUT_MS=90000
```

Add `QDRANT_API_KEY` only if the Qdrant host requires one. Jenkins creates
`RABBITMQ_URL` and sets `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, and
`API_GATEWAY_PORT`; they do not need entries in the protected file. Keep the approved alias separate from the staging
`QDRANT_COLLECTION`. Remove obsolete Google provider settings from the protected
file; the gateway no longer reads them. `CHAT_TEST_DATABASE_URL` and
`CHAT_TEST_DATABASE_ISOLATED` are only for disposable integration tests.
`NPM_TOKEN`, if required to fetch private GitHub Packages, is a build
credential and is not consumed by the runtime env file.

The `CHAT_BACKUP_RETENTION_DAYS` example above reflects this project's
reported seven-day restore window. Record `CHAT_BACKUP_VERIFIED_AT` only after
checking the actual backup/PITR window, encryption, and who can download or
restore backups in the Supabase project. The local `.env` does not configure
the Jenkins agent.

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
| `QDRANT_CHAT_COLLECTION` | Approved active alias; retrieval validates its manifest. |
| `RAG_SERVICE_URL`, `RAG_SERVICE_TOKEN` | Token-authenticated Python retrieval service. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL` | Server-side secret, trusted HTTPS API endpoint, and chat model. Rotate the key if exposed. |
| `OPENAI_REQUEST_TIMEOUT_MS`, `RAG_REQUEST_TIMEOUT_MS` | Model-stage timeout and total RAG deadline. |

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

Knowledge questions now use the internal token-authenticated Python retrieval service. It queries the approved active alias with text-embedding-3-small dense and BM25 sparse vectors, fuses/reranks results and returns source metadata. Only `license_status=APPROVED_FOR_RAG` is required for this accepted corpus. There is no staging excerpt fallback or direct text/scroll search. OpenAI receives selected evidence for sufficiency checks, grounded claims and independent quote validation. It uses minimal prior knowledge turns for query rewriting; account/report action results are excluded from knowledge context.

Explicit report/profile actions are classified separately. Their current user message may contain information the user supplies for an operation and is sent to OpenAI for intent/argument extraction. Retrieved account/report records are not sent as knowledge evidence. Missing model/retrieval configuration or provider errors return operational unavailable notices rather than substantive advice. Dynamic alerts/flood conditions are currently unsupported.

Source citations and reply metadata are stored inside encrypted assistant messages and remain accessible through owner-protected history. Approved source snapshots are served through JWT-authenticated `/chat/sources/:documentId/versions/:version`. External URLs are validated as HTTP(S) and constructed from corpus metadata; models cannot supply their own links.

Model inference sends the user question and selected retrieved passages to the
configured OpenAI endpoint. Keep `OPENAI_BASE_URL` on the official HTTPS API or
another explicitly trusted HTTPS endpoint. Do not log chat content, prompts,
passages, model responses, JWTs, refresh tokens, passwords or encryption keys.

Current flood-location/alert knowledge questions are unsupported; the static
RAG flow returns a scope notice. Explicit authenticated report operations remain
separate from knowledge and cannot turn reports into model evidence.

Before release, record the **actual** Supabase plan, daily backup and PITR
retention windows, encryption, and who can download/restore backups. The
Jenkins variables are a deployment gate, not proof that these settings are
correct. Deleted content can remain in retained backups until those backups
expire. No fixed deletion deadline is promised until the actual settings are
verified. Retire obsolete cloud keys and rotate any previously disclosed refresh token.

## Restore runbook

For the pre-release backup verification checklist and a step-by-step recovery
procedure, see the [chat history backup and recovery runbook](chat-backup-runbook.md).

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
