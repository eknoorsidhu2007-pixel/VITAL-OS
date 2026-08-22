-- VITAL OS — checks for supabase/migrations/0007_patients_hospital_default.sql
--
-- Commit path: supabase/checks/0007_patients_hospital_default.sql
--
-- CHECK 3 writes and rolls back. Everything else is read-only.
-- RUN ONE AT A TIME — the SQL Editor renders only the last statement's result.
--
-- RLS is still OFF for all of this. Nothing here should be denied; if
-- something is, RLS got enabled early and stage 4's comparison is void.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the default is now an expression
-- Expect:
--   COALESCE(current_hospital_id(), 'vital-demo-hospital'::text)
--
-- Still reading 'vital-demo-hospital'::text alone means the ALTER did not
-- apply.
-- ---------------------------------------------------------------------------
select column_name, column_default, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'patients'
  and column_name = 'hospital_id';


-- ---------------------------------------------------------------------------
-- CHECK 2 — EXECUTE grants after the reversal
-- Expect FOUR rows: anon, authenticated, postgres, service_role. PUBLIC absent.
--
-- postgres owns the function. service_role is there because ALTER DEFAULT
-- PRIVILEGES on this project grants ALL on new objects in public to anon,
-- authenticated and service_role -- functions included -- so 0006's
-- `revoke ... from public, anon` never reached it.
--
-- service_role's grant is REQUIRED, not residue. A column default is evaluated
-- as the inserting role, so a service_role insert omitting hospital_id must be
-- able to call this function. Revoking it breaks the sessionless path the
-- coalesce exists for.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'current_hospital_id'
order by grantee;


-- ---------------------------------------------------------------------------
-- CHECK 3 — the default resolves per caller
--
-- Forges a session, inserts WITHOUT naming hospital_id, reads back what the
-- default produced, and rolls the whole thing back. Substitute the tenant B
-- doctor's uuid.
--
-- Expect: vital-test-hospital
--
-- THIS IS THE WHOLE POINT OF THE MIGRATION. Before it, this insert produced
-- vital-demo-hospital -- a row in a tenant the caller does not belong to,
-- which 0008 would then refuse. Seeing the demo tenant here means the default
-- did not take.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT B DOCTOR UUID>')::text,
                  true);
insert into public.patients (id, mrn, name)
values ('pt-zz-default-probe', 'MRN-DEFAULT-PROBE', 'ZZ-PROBE Default Check');
select id, hospital_id from public.patients where id = 'pt-zz-default-probe';
rollback;

-- Sessionless, the fallback arm. Expect: vital-demo-hospital
begin;
select set_config('request.jwt.claims', null, true);
insert into public.patients (id, mrn, name)
values ('pt-zz-default-probe', 'MRN-DEFAULT-PROBE', 'ZZ-PROBE Default Check');
select id, hospital_id from public.patients where id = 'pt-zz-default-probe';
rollback;

-- Confirm the rollbacks took. Expect: 0 rows.
select id from public.patients where id = 'pt-zz-default-probe';


-- ---------------------------------------------------------------------------
-- CHECK 4 — LIVE, and this one is a REAL admit that has to be undone
--
-- Sign into the app as xtenant.b@vitalos.dev and admit a patient by voice or
-- by form. Name it something obvious: "ZZ-ADMIT Default Check".
--
-- Then:
--     select id, name, hospital_id from public.patients
--     where name like 'ZZ-ADMIT%';
--
-- Expect: hospital_id = vital-test-hospital
--
-- Before this migration the same admit produced vital-demo-hospital. This is
-- the only check that exercises the real path -- createPatientFromPayload()
-- omitting the column and letting the default decide -- rather than a forged
-- claim in a transaction.
--
-- Then remove it, because a stray patient breaks the row counts the stage-4
-- run is compared against:
--     delete from public.patients where name like 'ZZ-ADMIT%';
-- Expect: DELETE 1
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- CHECK 5 — existing rows are untouched
-- Expect the stage-2 split, unchanged:
--   vital-demo-hospital   28
--   vital-test-hospital   1
--
-- A column default applies to future inserts only. Any movement here means
-- something rewrote rows, which this migration does not do.
-- ---------------------------------------------------------------------------
select hospital_id, count(*) as patients
from public.patients
group by hospital_id
order by hospital_id;


-- ---------------------------------------------------------------------------
-- CHECK 6 — RLS is STILL OFF and the baseline is STILL open
-- Expect false, false, false, then:
--
--     npm run test:tenancy:open
--
-- All twelve lines ALLOWED, exactly as in stage 2 and stage 3. G2 is the line
-- to watch -- tenant A admitting into its own tenant now relies on the new
-- default resolving to vital-demo-hospital for that caller. If G2 flips to
-- DENIED with RLS off, the default is producing the wrong tenant for tenant A.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;
