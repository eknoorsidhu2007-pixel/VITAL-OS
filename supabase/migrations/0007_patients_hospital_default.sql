-- VITAL OS — Milestone 3, stage 3b: tenant-derived hospital_id default
--
-- Commit path: supabase/migrations/0007_patients_hospital_default.sql
--
-- Separated from 0006 because it CHANGES BEHAVIOUR rather than adding a gate,
-- and separated from 0008 because "enable RLS" should be a file that does
-- exactly one thing. Applied before RLS on purpose: the change is observable
-- with RLS off -- an admit lands in the caller's tenant instead of always the
-- demo one -- so it can be verified on its own, before anything starts denying.
--
-- Depends on 0006_rls_policies.sql for public.current_hospital_id().

-- ---------------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------------
--
-- createPatientFromPayload() (lib/patient-store.ts:205) deliberately omits
-- hospital_id so the column default applies -- the M2 decision that tenancy
-- binds in the database rather than in bypassable application code. That
-- decision was right; the default it relied on was a literal.
--
-- Once 0008 enables RLS, an admit by a clinician outside the demo tenant
-- inserts a demo-tenant row and is refused by its own patients_insert_own_tenant
-- policy: SQLSTATE 42501, surfacing as a 500 from POST /api/patients. Correct
-- refusal, wrong row -- the caller never asked for the demo tenant, the default
-- did.
--
-- Deriving the default from the caller keeps the M2 decision intact and makes
-- it true for every tenant instead of one.

alter table public.patients
  alter column hospital_id
  set default coalesce(public.current_hospital_id(), 'vital-demo-hospital');

comment on column public.patients.hospital_id is
  'Owning tenant. Defaults to the caller''s hospital via current_hospital_id(), falling back to the demo tenant for sessionless inserts (SQL Editor, service_role, seed). Pinned on write by the patients_insert/update_own_tenant policies from 0006.';

-- The coalesce is load-bearing in three places, all of which have no session
-- and so no tenant:
--
--   1. seedDemoPatientsIfEmpty() when it runs without a signed-in user
--   2. anything run from the SQL Editor or with the service_role key
--   3. the 0003-style backfills, if they are ever re-run
--
-- current_hospital_id() returns null for all three, and hospital_id is NOT
-- NULL. Without the fallback those inserts fail with a constraint violation
-- that says nothing about tenancy.

-- ---------------------------------------------------------------------------
-- Grant EXECUTE to anon -- reversing one line of 0006
-- ---------------------------------------------------------------------------
--
-- 0006 revoked this for tidiness: anon had no reason to call the function, so
-- it was closed off. There is now a functional reason to reopen it.
--
-- A column default is evaluated as the INSERTING role. With EXECUTE revoked
-- from anon, a sessionless insert fails with "permission denied for function
-- current_hospital_id" -- a confusing error from the grant layer, arriving
-- before RLS ever gets a say. Granting it back means anon evaluates the
-- default, gets null, and coalesces to the demo tenant, exactly as today.
--
-- Nothing leaks. The function returns the caller's own hospital and nothing
-- else, so anon calling it over the RPC endpoint receives null.

grant execute on function public.current_hospital_id() to anon;

-- What this does NOT do: it does not let anon insert. After 0008, anon has no
-- policy on patients at all, so the insert is refused regardless of what the
-- default resolved to. This grant only decides which error you get, and a
-- tenancy refusal is the honest one.
