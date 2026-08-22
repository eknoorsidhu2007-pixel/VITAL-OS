-- VITAL OS — checks for supabase/migrations/0006_rls_policies.sql
--
-- Commit path: supabase/checks/0006_rls_policies.sql
--
-- Read-only except CHECK 4, which runs inside a transaction it rolls back.
--
-- RUN ONE AT A TIME. The SQL Editor renders only the LAST statement's result.
--
-- The theme of this file: NOTHING SHOULD HAVE CHANGED YET. Policies exist,
-- RLS is off, and Postgres never consults a policy on a table with RLS
-- disabled. CHECK 6 is the one that proves it.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the helper function exists with the right properties
-- Expect exactly 1 row:
--   current_hospital_id | security_definer t | volatility s | config {search_path=}
--
-- security_definer f means the clinicians policy will recurse infinitely.
-- volatility v (not s) means the predicate is re-evaluated per row.
-- An empty config column means the search_path hardening was lost.
-- ---------------------------------------------------------------------------
select p.proname,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'current_hospital_id';


-- ---------------------------------------------------------------------------
-- CHECK 2 — who may execute it
-- Expect: authenticated present, anon absent, PUBLIC absent.
--
-- Functions are created with EXECUTE granted to PUBLIC, so an unrevoked
-- version is callable by anon over PostgREST's RPC endpoint.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'current_hospital_id'
order by grantee;


-- ---------------------------------------------------------------------------
-- CHECK 3 — every policy, and the clauses it carries
-- Expect exactly 6 rows:
--
--   clinicians | clinicians_select_own_tenant | SELECT | using yes | check no
--   hospitals  | hospitals_select_own_tenant  | SELECT | using yes | check no
--   patients   | patients_delete_own_tenant   | DELETE | using yes | check no
--   patients   | patients_insert_own_tenant   | INSERT | using NO  | check YES
--   patients   | patients_select_own_tenant   | SELECT | using yes | check no
--   patients   | patients_update_own_tenant   | UPDATE | using yes | check YES
--
-- The two rows to read carefully are the last two. INSERT with a null qual is
-- correct -- there is no prior row to test. UPDATE must show BOTH: the qual
-- picks which rows may be updated (closes D2), the with_check constrains what
-- they may become (closes D4, the mutable hospital_id gap). An UPDATE policy
-- with a null with_check leaves D4 open and every other assertion still
-- passes.
--
-- Every roles column should read {authenticated}. {public} anywhere means anon
-- is covered by a policy, and D6/D7 will not flip.
-- ---------------------------------------------------------------------------
select tablename,
       policyname,
       cmd,
       roles,
       qual       as using_clause,
       with_check as with_check_clause
from pg_policies
where schemaname = 'public'
  and tablename in ('hospitals', 'clinicians', 'patients')
order by tablename, policyname;


-- ---------------------------------------------------------------------------
-- CHECK 4 — the predicate returns the right tenant for each user
--
-- Run each block as a single Run. The SQL Editor connects as a superuser, so
-- auth.uid() is null here; set_config forges the JWT claim the function reads,
-- and the transaction is rolled back either way.
--
-- Substitute the two uuids from CHECK 2 of the fixture checks file.
--
-- Expect: 'vital-demo-hospital' for the tenant A doctor.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT A DOCTOR UUID>')::text,
                  true);
select public.current_hospital_id() as tenant_a_sees;
rollback;

-- Expect: 'vital-test-hospital' for the fixture doctor.
begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', '<TENANT B DOCTOR UUID>')::text,
                  true);
select public.current_hospital_id() as tenant_b_sees;
rollback;

-- Expect: null. No session, no tenant, and null denies every policy --
-- `hospital_id = null` is null, not true. This is the fail-closed path that
-- catches a user whose 0004 provisioning failed silently.
begin;
select set_config('request.jwt.claims', null, true);
select public.current_hospital_id() as no_session_sees;
rollback;


-- ---------------------------------------------------------------------------
-- CHECK 5 — RLS is STILL OFF
-- Expect false, false, false.
--
-- The whole point of splitting 0006 from 0007. If any of these reads true,
-- something enabled RLS ahead of the file that is supposed to -- most likely
-- the Supabase linter's "fix" button, which 0001 and 0002 both warn about.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;

-- relforcerowsecurity must also be false on clinicians. FORCE applies policies
-- to the table owner as well, which puts current_hospital_id() back inside the
-- recursion it was written to avoid.


-- ---------------------------------------------------------------------------
-- CHECK 6 — the denial test is UNCHANGED  ← the real check
--
--   npm run test:tenancy:open
--
-- EXPECTED: byte-for-byte the stage-2 baseline. All eight D-lines ALLOWED,
-- all four G-lines ALLOWED, PASS at the bottom. Row counts will differ by a
-- patient or two if you have admitted anything since; the ALLOWED/DENIED
-- column is what must match.
--
-- A policy on a table with RLS off is inert. Anything flipping to DENIED here
-- means RLS is on somewhere, and the before/after comparison this milestone is
-- built on is void -- stop and re-run CHECK 5.
--
-- Also worth one browser pass, signed in as either account: the roster, one
-- chart edit, one admit. Nothing should behave differently. If it does, the
-- cause is not these policies.
-- ---------------------------------------------------------------------------
