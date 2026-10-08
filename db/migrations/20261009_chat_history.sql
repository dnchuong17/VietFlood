CREATE SCHEMA IF NOT EXISTS private_chat;

REVOKE ALL ON SCHEMA private_chat FROM PUBLIC;

CREATE TABLE IF NOT EXISTS private_chat.sessions (
  id uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_idx
  ON private_chat.sessions (user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS private_chat.messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES private_chat.sessions(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind text NOT NULL CHECK (kind IN ('knowledge', 'first_aid', 'report_guide', 'report_status', 'fallback', 'legacy')),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  created_at timestamptz,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS chat_messages_session_sequence_idx
  ON private_chat.messages (session_id, sequence DESC);

ALTER TABLE private_chat.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_chat.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE private_chat.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_chat.messages FORCE ROW LEVEL SECURITY;

-- No permissive policies: custom VietFlood JWTs are not Supabase Auth tokens.
-- The postgres-derived backend role bypasses RLS, so every application query
-- must enforce ownership with the verified JWT user ID.
REVOKE ALL ON ALL TABLES IN SCHEMA private_chat FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA private_chat FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA private_chat FROM %I', role_name);
    END IF;
  END LOOP;
END;
$$;
