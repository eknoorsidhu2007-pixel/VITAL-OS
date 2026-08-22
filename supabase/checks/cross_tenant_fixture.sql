-- VITAL OS — checks for supabase/fixtures/0006_cross_tenant_fixture.sql
--
-- Commit path: supabase/checks/0006_cross_tenant_fixture.sql
--
-- Read-only. Safe to re-run at any time.
--
-- RUN ONE AT A TIME. The Supabase SQL Editor renders only the LAST statement's
-- result, so running this file whole silently discards every check but the
-- last. Highlight a single statement and press Run.
--
-- Stage 1 is still an ordinary setup step: everything below should look right
-- in the obvious way. CHECK 7 is the exception and is where M3 starts feeling
-- wrong -- read its header before running it.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the second tenant exists
-- Expect exactly 2 rows:
--   vital-demo-hospital   VITAL Demo Hospital
--   vital-test-hospital   VITAL Test Hospital (M3 fixture)
--
-- One row means the fixture did not run. Three means someone added a tenant
-- outside this file.
-- ---------------------------------------------------------------------------
select id, name, created_at
from public.hospitals
order by id;


-- ---------------------------------------------------------------------------
-- CHECK 2 — clinicians, one per tenant, with the right roles
-- Expect 4 rows: three in vital-demo-hospital (the M1 accounts) and exactly
-- one in vital-test-hospital, whose role is 'doctor'.
--
-- role 'staff' on the test-hospital row invalidates the whole milestone: staff
-- is refused clinical writes by the M2 role gate, so every stage-2 denial
-- would be unattributable to tenancy. The fixture refuses to run in that state,
-- so seeing it here means the row was edited afterwards.
-- ---------------------------------------------------------------------------
select c.id as uuid, c.hospital_id, c.role, c.full_name, c.staff_ref, u.email
from public.clinicians c
join auth.users u on u.id = c.id
order by c.hospital_id, c.role, u.email;


-- ---------------------------------------------------------------------------
-- CHECK 3 — the one-row-per-user invariant survived the new account
-- Expect: auth_users = clinicians, orphans = 0.
--
-- If auth_users exceeds clinicians, the 0004 trigger failed silently for the
-- new account -- it logs RAISE WARNING and never raises. Look in
-- Logs -> Postgres, then re-run 0003_backfill_clinicians.sql.
-- ---------------------------------------------------------------------------
select
  (select count(*) from auth.users)        as auth_users,
  (select count(*) from public.clinicians) as clinicians,
  (select count(*) from auth.users u
    where not exists (select 1 from public.clinicians c where c.id = u.id))
                                           as orphans;


-- ---------------------------------------------------------------------------
-- CHECK 4 — the fixture patient, correctly scoped and correctly attributed
-- Expect exactly 1 row:
--   pt-zz-xtenant-fixture | MRN-XTENANT-B | ZZ-XTENANT Test Patient
--   hospital_id  vital-test-hospital
--   clinician_id <the test doctor's uuid>
--   email        xtenant.b@vitalos.dev
--   discharged_at (null)
--
-- discharged_at NOT null means the row is filtered out of the active roster by
-- fetchAllRows() and would be invisible in stage 2 for reasons that have
-- nothing to do with tenancy. Re-run the fixture; it resets the column.
-- ---------------------------------------------------------------------------
select p.id, p.mrn, p.name, p.hospital_id, p.clinician_id, u.email, p.discharged_at
from public.patients p
left join auth.users u on u.id = p.clinician_id
where p.hospital_id = 'vital-test-hospital';


-- ---------------------------------------------------------------------------
-- CHECK 5 — roster split across the two tenants
-- Expect 2 rows:
--   vital-demo-hospital   22 or more   (the demo seed, plus anything admitted)
--   vital-test-hospital   1
--
-- 1 in the test hospital matters beyond arithmetic. seedDemoPatientsIfEmpty()
-- (lib/patient-store.ts:44) head-counts patients on EVERY roster fetch and
-- seeds when the count is zero. Once RLS lands, a tenant that can see no
-- patients fires that seeder, and the rows it inserts never mention
-- hospital_id -- they take the 'vital-demo-hospital' column default and get
-- rejected by the stage-3 WITH CHECK. The roster returns 500, not empty. This
-- one fixture row is what keeps tenant B off that path.
-- ---------------------------------------------------------------------------
select hospital_id, count(*) as patients
from public.patients
group by hospital_id
order by hospital_id;


-- ---------------------------------------------------------------------------
-- CHECK 6 — RLS is still OFF everywhere
-- Expect false, false, false.
--
-- This is the baseline gate for the whole milestone. Stage 2 records what the
-- database allows with no policies in place; a 'true' anywhere here means that
-- baseline is already contaminated and the before/after comparison proves
-- nothing. Stop and find out who enabled it -- the Supabase linter offers to,
-- and 0001 and 0002 both warn about accepting.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;


-- ---------------------------------------------------------------------------
-- CHECK 7 — LIVE APP  ←  THE EXPECTED RESULT LOOKS LIKE A FAILURE
--
-- Read this before running it.
--
--   npm run dev
--   Sign in as xtenant.b@vitalos.dev (the tenant-B doctor).
--
-- EXPECTED, and correct at this stage:
--
--   1. The roster shows the FULL demo roster -- all 22-plus patients belonging
--      to vital-demo-hospital, a tenant this user does not belong to.
--      That is the vulnerability M3 exists to close. Seeing it means the
--      fixture works and the before-state is real. NOT seeing it means
--      something is already filtering, and stage 2 will prove nothing.
--
--   2. ZZ-XTENANT Test Patient appears in that same roster when signed in as
--      EITHER tenant's user. Also expected. Also the vulnerability.
--
--   3. The header reads "VITAL Demo Hospital" for the tenant-B user.
--      Expected and unrelated to RLS: auth-provider.tsx:70 hard-codes
--      hospitalId to DEMO_HOSPITAL_ID, and nothing in the app reads
--      public.hospitals at all. This is the deferred GET /api/me gap becoming
--      visible. It does not affect any assertion in stage 2, which talks to
--      PostgREST directly.
--
--   4. Chart edits and admits work normally for the tenant-B doctor, on
--      tenant-A patients. Expected. The M2 role gate passes them because the
--      role is doctor; nothing checks tenancy yet.
--
-- Nothing in this check should be "fixed". Stage 4 inverts all four.
-- ---------------------------------------------------------------------------
