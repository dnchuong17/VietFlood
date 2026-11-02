CREATE SCHEMA IF NOT EXISTS private_incidents;
REVOKE ALL ON SCHEMA private_incidents FROM PUBLIC;

CREATE TABLE IF NOT EXISTS private_incidents.incidents (
 id uuid PRIMARY KEY, title text NOT NULL, province text NOT NULL DEFAULT '', ward text NOT NULL DEFAULT '',
 address text NOT NULL DEFAULT '', lat double precision, lng double precision,
 status text NOT NULL DEFAULT 'DETECTED' CHECK(status IN ('DETECTED','UNDER_REVIEW','VERIFIED','RESCUE_DEPLOYED','RESOLVED')),
 severity text NOT NULL DEFAULT 'UNKNOWN' CHECK(severity IN ('UNKNOWN','LOW','MODERATE','HIGH','CRITICAL')),
 version integer NOT NULL DEFAULT 1, evidence_version integer NOT NULL DEFAULT 1,
 verified_evidence_version integer, verified_facts jsonb NOT NULL DEFAULT '[]',
 assignee_id integer REFERENCES public.users(id) ON DELETE SET NULL,
 first_reported_at timestamptz NOT NULL, latest_reported_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 merged_into uuid REFERENCES private_incidents.incidents(id),
 CHECK ((lat IS NULL AND lng IS NULL) OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180))
);
CREATE INDEX IF NOT EXISTS incident_recent_idx ON private_incidents.incidents(updated_at DESC,id DESC) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS incident_geo_time_idx ON private_incidents.incidents(lat,lng,latest_reported_at) WHERE merged_into IS NULL AND status <> 'RESOLVED';
ALTER TABLE private_incidents.incidents ADD COLUMN IF NOT EXISTS centroid double precision[];
ALTER TABLE private_incidents.incidents ADD COLUMN IF NOT EXISTS embedding_fingerprint text;
ALTER TABLE private_incidents.incidents ADD COLUMN IF NOT EXISTS analysis_complete boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS private_incidents.retained_reports (
 report_id integer PRIMARY KEY REFERENCES public.reports(id) ON DELETE RESTRICT,
 revision integer NOT NULL, archived_at timestamptz, emergency boolean NOT NULL DEFAULT false,
 review_state text NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','review','linked','excluded')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_incidents.report_revisions (
 report_id integer NOT NULL REFERENCES private_incidents.retained_reports(report_id), revision integer NOT NULL,
 snapshot jsonb NOT NULL, content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(report_id,revision)
);
CREATE TABLE IF NOT EXISTS private_incidents.analysis (
 report_id integer NOT NULL, revision integer NOT NULL, pipeline text NOT NULL,
 result jsonb NOT NULL, embedding double precision[] NOT NULL, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(report_id,revision,pipeline),
 FOREIGN KEY(report_id,revision) REFERENCES private_incidents.report_revisions(report_id,revision)
);
CREATE TABLE IF NOT EXISTS private_incidents.memberships (
 id bigserial PRIMARY KEY, incident_id uuid NOT NULL REFERENCES private_incidents.incidents(id),
 report_id integer NOT NULL REFERENCES private_incidents.retained_reports(report_id),
 manual boolean NOT NULL DEFAULT false, joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident_per_report ON private_incidents.memberships(report_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS incident_members_idx ON private_incidents.memberships(incident_id,report_id) WHERE left_at IS NULL;
CREATE TABLE IF NOT EXISTS private_incidents.reviews (
 report_id integer PRIMARY KEY REFERENCES private_incidents.retained_reports(report_id), revision integer NOT NULL,
 reason text NOT NULL, candidates jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_incidents.summaries (
 id bigserial PRIMARY KEY, incident_id uuid NOT NULL REFERENCES private_incidents.incidents(id),
 evidence_version integer NOT NULL, job_id uuid NOT NULL UNIQUE, content jsonb NOT NULL, model text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_incidents.assignments (
 id bigserial PRIMARY KEY, incident_id uuid NOT NULL REFERENCES private_incidents.incidents(id),
 assignee_id integer NOT NULL, actor_id integer NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment ON private_incidents.assignments(incident_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS private_incidents.audit (
 id bigserial PRIMARY KEY, incident_id uuid REFERENCES private_incidents.incidents(id),
 actor_id integer, action text NOT NULL, reason text NOT NULL DEFAULT '', details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_incidents.jobs (
 id uuid PRIMARY KEY, parent_id uuid REFERENCES private_incidents.jobs(id), kind text NOT NULL CHECK(kind IN ('analyze','summary','batch')),
 dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','obsolete')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incident_jobs_pending_idx ON private_incidents.jobs(available_at,created_at) WHERE status IN ('pending','running');
CREATE TABLE IF NOT EXISTS private_incidents.batch_jobs (
 parent_id uuid NOT NULL REFERENCES private_incidents.jobs(id), job_id uuid NOT NULL REFERENCES private_incidents.jobs(id), PRIMARY KEY(parent_id,job_id)
);
CREATE TABLE IF NOT EXISTS private_incidents.outbox (
 id bigserial PRIMARY KEY, event text NOT NULL, payload jsonb NOT NULL, published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private_incidents.receipts (
 actor_id integer NOT NULL, operation text NOT NULL, key text NOT NULL, hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation,key)
);

-- Optional accelerator; correctness never depends on the extension being installed.
DO $$ DECLARE ns text; BEGIN
 SELECT n.nspname INTO ns FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis';
 IF ns IS NOT NULL THEN
   EXECUTE format('CREATE INDEX IF NOT EXISTS incident_geography_idx ON private_incidents.incidents USING gist ((%I.ST_SetSRID(%I.ST_MakePoint(lng,lat),4326)::%I.geography)) WHERE lat IS NOT NULL AND lng IS NOT NULL',ns,ns,ns);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION private_incidents.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Incident evidence and audit records are append-only'; END $$;
DROP TRIGGER IF EXISTS immutable_revision ON private_incidents.report_revisions;
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON private_incidents.report_revisions FOR EACH ROW EXECUTE FUNCTION private_incidents.immutable_record();
DROP TRIGGER IF EXISTS immutable_audit ON private_incidents.audit;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON private_incidents.audit FOR EACH ROW EXECUTE FUNCTION private_incidents.immutable_record();

REVOKE ALL ON ALL TABLES IN SCHEMA private_incidents FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA private_incidents FROM PUBLIC;
DO $$ DECLARE r text; t text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
     EXECUTE format('REVOKE ALL ON SCHEMA private_incidents FROM %I',r);
     EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA private_incidents FROM %I',r);
   END IF;
 END LOOP;
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='private_incidents' LOOP
   EXECUTE format('ALTER TABLE private_incidents.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
