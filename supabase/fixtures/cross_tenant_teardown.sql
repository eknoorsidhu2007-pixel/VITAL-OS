-- VITAL OS — Milestone 3: cross-tenant fixture teardown
--
-- Commit path: supabase/fixtures/0006_cross_tenant_teardown.sql
--
-- Reverses supabase/fixtures/0006_cross_tenant_fixture.sql. Run it when M3 is
-- finished and the denial test is no longer being re-run, or before handing the
-- database to anyone who should not see a fake patient in the roster.
--
-- DO NOT RUN THIS BETWEEN STAGES 2 AND 4. The denial test needs the fixture on
-- both sides of the RLS switch; removing it mid-milestone makes the after-run
-- pass for the wrong reason -- zero rows because there is nothing there, not
-- zero rows because a policy denied them.
--
-- Order matters. patients.hospital_id -> hospitals(id) has no ON DELETE
-- clause, so the patient goes before the hospital or the delete fails on a
-- foreign key violation.
--
-- Idempotent. Re-running deletes nothing and reports success.

do $$
declare
  v_email     constant text := 'xtenant.b@vitalos.dev';
  v_hospital  constant text := 'vital-test-hospital';
  v_patient   constant text := 'pt-zz-xtenant-fixture';
  v_user_id   uuid;
begin
  -- 1. The fixture patient.
  delete from public.patients where id = v_patient;

  -- 2. The clinician goes back to the demo tenant rather than being deleted.
  --    clinicians.id cascades from auth.users, so the row belongs to the auth
  --    account's lifecycle; deleting it here would leave the account signed-in
  --    capable and denied everywhere by getCallerClinician(), which looks
  --    identical to a provisioning failure.
  select id into v_user_id from auth.users where email = v_email;

  if v_user_id is not null then
    update public.clinicians
       set hospital_id = 'vital-demo-hospital'
     where id = v_user_id;
  end if;

  -- 3. The tenant itself. Guarded: if any patient or clinician still points
  --    here, leave it and say so rather than failing on a foreign key.
  if exists (select 1 from public.patients   where hospital_id = v_hospital)
  or exists (select 1 from public.clinicians where hospital_id = v_hospital)
  then
    raise notice
      'VITAL-OS teardown: rows still reference %; hospital left in place. Check public.patients and public.clinicians.',
      v_hospital;
  else
    delete from public.hospitals where id = v_hospital;
    raise notice 'VITAL-OS teardown complete. Tenant % removed.', v_hospital;
  end if;
end
$$;

-- The auth account itself is not removed here -- Authentication -> Users ->
-- delete, if you want it gone. That cascades public.clinicians via the
-- ON DELETE CASCADE in 0002_clinicians.sql, which is why step 2 above does not
-- need to clean up after it.
