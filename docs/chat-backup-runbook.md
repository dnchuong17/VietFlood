# Chat history backup and recovery runbook

This runbook is for the operator responsible for protecting and restoring persistent VietFlood chat history in Supabase PostgreSQL. It describes what to verify before release and what to do after a database restore. It does not assume a particular Supabase plan or backup retention window; record the values shown by the project's current settings.

## Data covered

Chat sessions and messages are stored in the private `private_chat` schema. Message bodies are encrypted by the application with AES-256-GCM. The database backup contains the encrypted message fields, session ownership, timestamps, and sequence metadata. A database backup alone is not sufficient to read the messages: retain the matching chat keyring securely for at least as long as any backup may be restored.

The application has no external deletion ledger. A restore can therefore bring back sessions or messages that users deleted after the restore point. This runbook requires reconciling those deletions or purging restored chat history before chat is reopened.

## Before release: verify backup protection

Complete these checks in the Supabase project and record the observed values in the deployment record:

1. Identify the project, database, plan, and region that host `private_chat`.
2. Check the configured automated backup and point-in-time recovery (PITR) windows. Record each window separately, including its start and end limits.
3. Confirm whether backups and PITR data are encrypted at rest, and identify the provider-managed or customer-managed key arrangement.
4. Identify which people and service accounts can view, download, or restore backups. Remove access that is not needed for on-call recovery.
5. Confirm the application keyring is stored separately from database backups in an approved secret store, and that an authorized operator can retrieve the correct key versions during recovery.
6. Verify the database TLS CA and connection details required by the gateway are available in the protected runtime environment.
7. Record who checked the settings and when. Recheck after plan changes, project migrations, or backup policy changes.

Only after completing the checks, set the deployment markers:

```ini
CHAT_BACKUP_RETENTION_DAYS=<verified recovery window in days>
CHAT_BACKUP_VERIFIED_AT=<date checked, YYYY-MM-DD>
```

`CHAT_BACKUP_RETENTION_DAYS` should reflect the approved recovery window actually available for this project. Do not copy a sample value from another environment. `CHAT_BACKUP_VERIFIED_AT` records when the settings were checked; it does not prove that a backup exists or that a restore has been tested. Keep the supporting evidence and access review in the deployment record, not in a committed `.env` file.

## During recovery

Keep chat unavailable until the restored data has been reviewed. The API returns `503` for chat routes when `CHAT_HISTORY_ENABLED=false`.

1. Set `CHAT_HISTORY_ENABLED=false` in the protected runtime environment and restart or otherwise ensure all gateway instances use the setting. Confirm chat endpoints return `503`.
2. Restore the database to the selected recovery point using the project's approved Supabase procedure. Restrict access to the restored environment while it is being examined.
3. Apply the chat history migration if the restored database does not contain the current `private_chat` schema. Confirm the application can connect using verified TLS and the required keyring is available.
4. Determine which chat sessions and user accounts were deleted after the recovery point. Use complete, trustworthy deletion records to reapply those deletions.
5. If deletion reconciliation is incomplete, purge all restored chat history while chat remains unavailable:

   ```sql
   TRUNCATE private_chat.sessions CASCADE;
   ```

6. Verify the final state before reopening chat:

   ```sql
   SELECT count(*) AS sessions FROM private_chat.sessions;
   SELECT count(*) AS messages FROM private_chat.messages;
   ```

   Both counts must be zero if history was purged. If history was preserved or reconciled, review representative ownership and message reads through the application instead.

7. Confirm current database ownership checks, TLS validation, key versions, and application health. Set `CHAT_HISTORY_ENABLED=true`, restart or refresh all gateway instances, and verify authenticated list, read, send, and delete operations with a disposable test account/session. Remove the test session after verification.
8. Notify affected users if their history was purged or the restored history differs from what they last saw. Apply the normal backup expiry and access restrictions to temporary restore artifacts.

## After recovery

Record the selected restore point, recovery start and end times, whether history was reconciled or purged, checks performed, and user communication. Review whether the recovery exposed gaps in deletion tracking, backup access, key availability, or the documented recovery window, then update the deployment record and this runbook as needed.

## Related references

- [Chat API guide](chat-api.md) describes the frontend endpoints for listing, reading, and deleting conversations.
- [Chat security and operations](chat-security.md) documents database isolation, encryption, deployment configuration, and key rotation.
