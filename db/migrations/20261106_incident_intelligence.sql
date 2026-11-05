-- Additive: no existing verification is promoted to the new pipeline.
ALTER TABLE private_incidents.incidents ADD COLUMN IF NOT EXISTS verified_pipeline text;
CREATE TABLE IF NOT EXISTS private_incidents.summary_edits (
 id bigserial PRIMARY KEY,
 incident_id uuid NOT NULL REFERENCES private_incidents.incidents(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 actor_id integer,
 evidence_version integer NOT NULL,
 pipeline text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incident_summary_edits_idx ON private_incidents.summary_edits(incident_id,id DESC);
DROP TRIGGER IF EXISTS immutable_summary_edit ON private_incidents.summary_edits;
CREATE TRIGGER immutable_summary_edit BEFORE UPDATE OR DELETE ON private_incidents.summary_edits
 FOR EACH ROW EXECUTE FUNCTION private_incidents.immutable_record();
ALTER TABLE private_incidents.summary_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private_incidents.summary_edits FROM PUBLIC;
REVOKE ALL ON SEQUENCE private_incidents.summary_edits_id_seq FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON private_incidents.summary_edits FROM %I',r);
   EXECUTE format('REVOKE ALL ON SEQUENCE private_incidents.summary_edits_id_seq FROM %I',r);
  END IF;
 END LOOP;
END $$;
