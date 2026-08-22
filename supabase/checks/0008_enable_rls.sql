-- VITAL OS — checks for supabase/migrations/0008_enable_rls.sql
--
-- Commit path: supabase/checks/0008_enable_rls.sql
--
-- Read-only, except CHECK 3 which writes and rolls back.
-- RUN ONE AT A TIME — the SQL Editor renders only the last statement's result.
--
-- READ THIS FIRST. The SQL Editor connects as a superuser, which BYPASSES RLS.
-- Nothing you run in the SQL Editor is subject to a policy, so no query here
-- can demonstrate a denial by returning fewer rows. CHECK 3 works around it by
-- forging a claim AND switching role; everything else checks configuration,
-- and the actual denials are proven by CHECK 4 and CHECK 5 from outside the
-- database.

-- ---------------------------------------------------------------------------
-- CHECK 1 — RLS is on, FORCE is off
-- Expect:
--   clinicians  true  false
--   hospitals   true  false
--   patients    true  false
--
-- rls_forced TRUE on clinicians is the failure to look for. FORCE applies
-- policies to the owner, which puts current_hospital_id() back inside the
-- recursion it was written to avoid, and breaks the 0004 provisioning trigger.
-- Symptom: "infinite recursion detected in policy for relation clinicians" on
-- every authenticated request.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;


-- ---------------------------------------------------------------------------
-- CHECK 2 — no table is protected by RLS with zero policies
-- Expect 3 rows: clinicians 1, hospitals 1, patients 4.
--
-- RLS on with no policy for a command denies that command outright. A count of
-- 0 anywhere means that table is now unreadable by every non-superuser, which
-- looks exactly like a working denial until the app 500s.
-- ---------------------------------------------------------------------------
select c.relname, count(p.polname) as policies
from pg_class c
left join pg_policy p on p.polrelid = c.oid
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('clinicians', 'hospitals', 'patients')
group by c.relname
order by c.relname;


-- ---------------------------------------------------------------------------
-- CHECK 3 — a denial, observed inside the database
--
-- Run each block as one Run. `set local role authenticated` is what makes this
-- meaningful: without it you are still a superuser and RLS is bypassed.
-- Substitute the tenant B doctor's uuid.
--
-- Expect: 1 -- the fixture patient, and nothing else.
-- Before 0008 this returned 29.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT B DOCTOR UUID>')::text,
                  true);
set local role authenticated;
select count(*) as rows_tenant_b_can_see from public.patients;
rollback;

-- The WITH CHECK path, which is the only denial that raises rather than
-- returning quietly.
--
-- Expect: ERROR 42501, new row violates row-level security policy for table
-- "patients". An error here is the PASS.
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT B DOCTOR UUID>')::text,
                  true);
set local role authenticated;
insert into public.patients (id, mrn, name, hospital_id)
values ('pt-zz-rls-probe', 'MRN-RLS-PROBE', 'ZZ-PROBE RLS', 'vital-demo-hospital');
rollback;

-- The USING path on UPDATE, which does NOT raise. Expect: 0.
-- This is the denial shape that would score as a pass under any
-- status-code-based assertion.
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT B DOCTOR UUID>')::text,
                  true);
set local role authenticated;
with moved as (
  update public.patients set room = 'RLS-PROBE'
  where hospital_id = 'vital-demo-hospital'
  returning id
)
select count(*) as rows_tenant_b_could_update from moved;
rollback;


-- ---------------------------------------------------------------------------
-- CHECK 4 — the flip  ← THE CHECK THIS MILESTONE EXISTS FOR
--
--     npm run test:tenancy
--
-- Note the command changed: no :open. From here on the spec runs with
-- --expect=closed.
--
-- EXPECT, and every line of this is the inverse of the baseline recorded three
-- times in stages 2, 3 and 3b:
--
--   D1  DENIED   0 patients returned            was 28
--   D2  DENIED   0 rows affected                was 1 row written
--   D3  DENIED   refused by RLS (42501)         was 1 row written
--   D4  DENIED   0 rows affected                was 1 row written
--   D5  DENIED   0 clinicians returned          was 3
--   D6  DENIED   0 patients returned            was 30
--   D7  DENIED   0 rows affected                was 1 row written
--   D8  DENIED   0 patients returned            was 1
--   G1  ALLOWED  28 patients returned           unchanged
--   G2  ALLOWED  1 row written                  unchanged
--   G3  ALLOWED  1 row written                  unchanged
--   G4  ALLOWED  1 patients returned            unchanged
--
-- The G-lines matter as much as the D-lines. A policy that denies everything
-- turns all eight D-lines green while breaking the application completely.
--
-- Two denial shapes to read carefully. D3 is the only one that reports 42501,
-- because a WITH CHECK violation raises. D2, D4 and D7 report "0 rows
-- affected" with no error at all -- PostgREST returns success for an UPDATE
-- whose target rows are invisible. That asymmetry is why the spec classifies
-- on rows rather than status.
--
-- Also expect the cleanup block to change: D3's forged row never existed, so
-- pt-zz-denial-probe-b-into-a is reported removed having never been created,
-- and the fixture patient never moved, so its restore is a no-op.
--
-- One line will now be a genuinely different mechanism: the D2/D7 note about
-- room = XTENANT-PROBE. Neither write lands any more, so no demo patient is
-- modified by this run. From here the spec is non-destructive.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- CHECK 5 — the full M2 live sequence, in the browser
--
-- A policy that denies cross-tenant access can just as easily deny same-tenant
-- access, and only the running application exercises the paths that matter.
-- Every one of these worked before 0008 and must still work.
--
-- Signed in as a TENANT A doctor:
--   1. Roster loads. Expect 23 active patients -- 24 before, minus the tenant
--      B fixture patient, which is now invisible. THIS DROP IS THE PASS.
--   2. Admit a patient by voice. Expect success, and the row's hospital_id to
--      be vital-demo-hospital.
--   3. Edit a chart field on any patient. Expect success.
--   4. Discharge that patient. Expect success and removal from the roster.
--   5. DevTools console:
--        await (await fetch('/api/patients')).json()
--      Expect 23, and no pt-zz-xtenant-fixture in the list.
--
-- Signed in as the TENANT B doctor (xtenant.b@vitalos.dev):
--   6. Roster loads. Expect exactly 1 patient -- ZZ-XTENANT Test Patient.
--      Not an error, not an empty state. If the roster 500s, read the note on
--      the seeder below.
--   7. DevTools console, with a tenant A patient id:
--        await (await fetch('/api/patients/pt-maria-garcia')).json()
--      Expect { error: 'Not found.' } and a 404 -- NOT a 403.
--      getPatientById() uses .maybeSingle(), so an RLS-invisible row is
--      indistinguishable from a missing one. Correct behaviour; do not "fix"
--      it into a 403.
--   8. Admit a patient. Expect success, and the row landing in
--      vital-test-hospital -- this is 0007's default doing its job under RLS.
--   9. Edit a chart field on ZZ-XTENANT Test Patient. Expect success.
--
-- Signed out entirely:
--  10. DevTools console on the login page:
--        await (await fetch('/api/patients')).json()
--      Expect an empty roster or an error, NOT 30 patients.
--
-- Then undo step 2's and step 8's admits, and step 4's discharge if it matters
-- to you, so the counts stay comparable:
--     delete from public.patients where created_at > now() - interval '1 hour'
--       and id not in ('pt-zz-xtenant-fixture') returning id, name, hospital_id;
--
-- ---------------------------------------------------------------------------
-- THE SEEDER, if step 6 fails
-- ---------------------------------------------------------------------------
--
-- seedDemoPatientsIfEmpty() (lib/patient-store.ts:44) head-counts patients on
-- every roster fetch and seeds 22 demo rows when the count is zero. Under RLS
-- a tenant that can see nothing gets a count of zero and fires it. With 0007's
-- default those rows now land in the CALLER'S tenant and succeed -- which is
-- worse than failing: tenant B's roster would silently fill with 22 copies of
-- the demo patients.
--
-- The fixture patient is what prevents this. Tenant B's count is 1, so the
-- seeder never runs. G4 in the spec exists to keep it that way.
--
-- If it ever fires: delete the copies by hospital_id, confirm the fixture
-- patient is present, and treat "the seeder is reachable by any tenant" as an
-- M4 item. It is not an RLS bug -- the policies did exactly what they should.
-- ---------------------------------------------------------------------------
