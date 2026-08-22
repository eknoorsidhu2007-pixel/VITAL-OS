-- VITAL OS — Milestone 3, stage 3: RLS policies
--
-- Commit path: supabase/migrations/0006_rls_policies.sql
--
-- Creates the tenant helper and every policy. Does NOT enable RLS -- that is
-- 0007_enable_rls.sql, deliberately a separate file. A policy on a table with
-- RLS off is inert: Postgres stores it and never consults it. So this file
-- changes nothing observable, and that is the point. Running the denial test
-- after applying it must produce output identical to the stage-2 baseline:
--
--   npm run test:tenancy:open     -> still 12 lines, all ALLOWED
--
-- If anything flips to DENIED here, RLS is already on somewhere and the
-- milestone's before/after comparison is void.
--
-- Depends on 0005_patients_tenancy.sql.
-- Idempotent: CREATE OR REPLACE plus DROP POLICY IF EXISTS.

-- ---------------------------------------------------------------------------
-- The tenant predicate
-- ---------------------------------------------------------------------------
--
-- Every policy below reduces to "does this row's hospital_id match the
-- caller's". The caller's hospital lives in public.clinicians, keyed on
-- auth.uid() -- the architecture decision from v4, unchanged: a profile-table
-- subquery rather than a custom access token hook, because claims bake at
-- issue time and go stale, and because a hook is dashboard configuration
-- invisible to this repo.
--
-- SECURITY DEFINER is not optional here, for two reasons:
--
--   1. RECURSION. The policy on public.clinicians needs the caller's hospital,
--      which means selecting from public.clinicians, which fires the policy
--      again -- Postgres reports "infinite recursion detected in policy for
--      relation clinicians" and every query against the table fails. Running
--      as the owner sidesteps it: table owners bypass RLS.
--
--      COROLLARY: do NOT add ALTER TABLE ... FORCE ROW LEVEL SECURITY to
--      clinicians. Forcing RLS applies policies to the owner as well, which
--      puts the recursion straight back.
--
--   2. VISIBILITY. Once clinicians has a policy, an unprivileged caller can
--      only see rows in their own hospital -- which is the row this function
--      needs to read in order to know which hospital that is. Circular.
--      Definer rights break the circle.
--
-- STABLE, and every call site wraps it in a scalar subquery -- (select
-- public.current_hospital_id()) rather than a bare call. Postgres then hoists
-- it to an InitPlan and evaluates it once per statement instead of once per
-- row. On a 30-row demo table that is invisible; on a real roster it is the
-- difference between one lookup and one per candidate row.
--
-- SET search_path = '': the same hardening as the 0004 trigger. Every
-- identifier below is schema-qualified, including auth.uid().

create or replace function public.current_hospital_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.hospital_id
  from public.clinicians c
  where c.id = (select auth.uid());
$$;

comment on function public.current_hospital_id() is
  'Tenant predicate for every RLS policy. SECURITY DEFINER to avoid recursion through the clinicians policy. Returns null when there is no session or no clinicians row, which denies everywhere.';

-- Null is the fail-closed value. No session, or a session whose provisioning
-- failed, yields null, and `hospital_id = null` is null, not true -- so the row
-- is not visible. The 0004 trigger swallowing its own failures means "user
-- with no clinicians row" is a state that really happens; this is where it
-- lands, and it lands denied.

-- Functions are created with EXECUTE granted to PUBLIC. Left alone, anon could
-- call this directly through PostgREST's RPC endpoint. It would return null
-- for anon and leak nothing, but there is no reason to expose it.
revoke all on function public.current_hospital_id() from public, anon;
grant execute on function public.current_hospital_id() to authenticated;

-- ---------------------------------------------------------------------------
-- hospitals
-- ---------------------------------------------------------------------------
--
-- Read-only, and only your own tenant. Nothing in the application reads this
-- table today -- auth-provider.tsx:70 hard-codes hospitalId to
-- DEMO_HOSPITAL_ID -- so this policy binds nothing yet. It is here for the
-- deferred GET /api/me, which will join it for the display name.
--
-- No INSERT/UPDATE/DELETE policy anywhere in this file. A table with RLS on
-- and no policy for a command denies that command outright; there is no
-- "deny" statement to write. Hospitals are administrative records: the
-- application resolves a tenant, it never creates one.

drop policy if exists hospitals_select_own_tenant on public.hospitals;
create policy hospitals_select_own_tenant
  on public.hospitals
  for select
  to authenticated
  using (id = (select public.current_hospital_id()));

-- ---------------------------------------------------------------------------
-- clinicians
-- ---------------------------------------------------------------------------
--
-- Closes D5: with RLS off, any authenticated user reads every clinician row in
-- every tenant -- names and roles. Read-only, so disclosure rather than
-- escalation, and 0002 recorded it as exactly what the denial test was written
-- to catch.
--
-- Colleagues in your own hospital stay visible. Narrowing this to id =
-- auth.uid() would be tighter, but getCallerClinician() only ever reads its
-- own row anyway, so the tenant scope costs nothing today and leaves room for
-- a care-team view later.
--
-- No write policies. Writes come from the 0004 provisioning trigger, which
-- runs SECURITY DEFINER as the owner and bypasses RLS. That is the whole
-- reason role is safe here: there is no policy under which a browser can
-- UPDATE its own role to 'doctor'.

drop policy if exists clinicians_select_own_tenant on public.clinicians;
create policy clinicians_select_own_tenant
  on public.clinicians
  for select
  to authenticated
  using (hospital_id = (select public.current_hospital_id()));

-- ---------------------------------------------------------------------------
-- patients
-- ---------------------------------------------------------------------------
--
-- Four separate policies rather than one FOR ALL. FOR ALL applies the same
-- USING to reads and writes and derives WITH CHECK from it, which reads as
-- equivalent and is not: it makes the insert case implicit, and the insert
-- case is the one carrying the tenancy pin. Explicit is worth the extra lines
-- on the table that holds the clinical data.

drop policy if exists patients_select_own_tenant on public.patients;
create policy patients_select_own_tenant
  on public.patients
  for select
  to authenticated
  using (hospital_id = (select public.current_hospital_id()));

-- INSERT takes WITH CHECK only -- there is no existing row to test, so a
-- USING clause on INSERT is meaningless and Postgres rejects it.
--
-- This is what closes D3. It also pins the column for free: an insert that
-- names someone else's hospital_id is refused, and an insert that names none
-- takes the column default of 'vital-demo-hospital', which passes this check
-- only for callers actually in the demo tenant. See the note at the bottom.
drop policy if exists patients_insert_own_tenant on public.patients;
create policy patients_insert_own_tenant
  on public.patients
  for insert
  to authenticated
  with check (hospital_id = (select public.current_hospital_id()));

-- UPDATE takes BOTH, and both are load-bearing in different directions:
--
--   USING      which rows you may update       -> closes D2
--   WITH CHECK what they may become            -> closes D4
--
-- Without WITH CHECK, a clinician could take a patient they legitimately own
-- and rewrite hospital_id to another tenant -- the row passes USING on the way
-- in and nothing inspects it on the way out. That is the mutable-hospital_id
-- gap 0005 documented and deferred here: patients holds a table-level UPDATE
-- grant, which implies UPDATE on every column including ones added later, and
-- a column-level REVOKE cannot remove it. Verified in M2 against
-- information_schema.column_privileges, where the revoke ran successfully and
-- changed nothing.
--
-- This is the fix, and it needs no column enumeration -- it covers every
-- column added from here on for free.
drop policy if exists patients_update_own_tenant on public.patients;
create policy patients_update_own_tenant
  on public.patients
  for update
  to authenticated
  using (hospital_id = (select public.current_hospital_id()))
  with check (hospital_id = (select public.current_hospital_id()));

drop policy if exists patients_delete_own_tenant on public.patients;
create policy patients_delete_own_tenant
  on public.patients
  for delete
  to authenticated
  using (hospital_id = (select public.current_hospital_id()));

-- ---------------------------------------------------------------------------
-- What is deliberately absent
-- ---------------------------------------------------------------------------
--
-- NO POLICY FOR anon, on any table. That is what closes D6 and D7 -- the two
-- that matter most, because NEXT_PUBLIC_SUPABASE_ANON_KEY ships to every
-- browser that loads the app, and the M2 role gate only ever covered /api/*.
-- A signed-out caller hitting /rest/v1/patients directly currently reads and
-- writes the entire table.
--
-- The table grants from supabase/patients.sql stay as they are. anon keeps
-- SELECT/INSERT/UPDATE/DELETE on patients and gets zero rows and refused
-- writes, because grants and policies are independent gates and a request
-- must pass both. Revoking the grants as well would be belt and braces; it is
-- also a second mechanism to keep in sync, and RLS is the one being tested.
--
-- NO ROLE CHECKS ANYWHERE. These policies are about tenancy only. doctor vs
-- staff stays where M2 put it, in isRestrictedClinicalPatch and requireDoctor
-- at the route layer. Duplicating it here would put the same rule in two
-- places with two ways to drift, and PostgREST-direct callers are denied by
-- tenancy regardless.
--
-- ---------------------------------------------------------------------------
-- Known consequence, decide before 0007
-- ---------------------------------------------------------------------------
--
-- patients.hospital_id still defaults to the literal 'vital-demo-hospital',
-- and createPatientFromPayload() (lib/patient-store.ts:205) deliberately omits
-- the column so the default applies. Once RLS is on, that means an admit by a
-- clinician OUTSIDE the demo tenant inserts a demo-tenant row and is refused
-- by patients_insert_own_tenant -- SQLSTATE 42501, surfacing as a 500 from
-- POST /api/patients.
--
-- For the fixture doctor that is correct and harmless. It matters the moment a
-- real second tenant exists. The fix is one line, and it is not in this file
-- because it changes behaviour rather than adding a gate:
--
--   alter table public.patients
--     alter column hospital_id
--     set default coalesce(public.current_hospital_id(), 'vital-demo-hospital');
--
-- The coalesce keeps the seed path and any SQL Editor insert working, where
-- auth.uid() is null and the function returns null against a NOT NULL column.
