-- VITAL OS — Milestone 3, stage 1: cross-tenant fixture
--
-- Commit path: supabase/fixtures/0006_cross_tenant_fixture.sql
--
-- THIS IS NOT A MIGRATION, deliberately. It lives outside
-- supabase/migrations/ and is absent from the README's setup order, because
-- supabase/migrations/ is the deployment contract: anything in there runs on
-- every deployment forever, and this file seeds a fake hospital and a fake
-- patient. Committed rather than local-only so the denial test is reproducible
-- by anyone with the repo and survives a database reset.
--
-- Teardown: supabase/fixtures/0006_cross_tenant_teardown.sql
-- Verify:   supabase/checks/0006_cross_tenant_fixture.sql
--
-- Depends on 0001_hospitals.sql through 0005_patients_tenancy.sql, and on
-- supabase/add_patient_voice_fields.sql (discharged_at).
--
-- PREREQUISITE, and it cannot be done in SQL: the tenant-B clinician needs a
-- real auth.users row. Signups are disabled on this instance (verified: POST
-- /auth/v1/signup returns 422 signup_disabled), and hand-inserting into
-- auth.users means hand-managing password hashes and the identities table.
-- Create the account in the dashboard first -- Authentication -> Users ->
-- Add user -- with these fields:
--
--   Email:          xtenant.b@vitalos.dev      (must match v_email below)
--   Password:       anything; store it in C:\Users\<you>\vital-os-ops\.env.tenancy
--   Auto Confirm:   ON
--   User Metadata:  {"role":"doctor","full_name":"Cross-Tenant Test Doctor","doctor_id":"DOC-XTENANT"}
--
-- ROLE MUST BE doctor, and this file refuses to run otherwise. A staff user in
-- hospital B would be refused clinical writes by the M2 role gate, so every
-- denial in the stage-2 test would be unattributable -- the exact failure mode
-- recorded in handoff v5, where staff was "correctly refused" a chart edit
-- while actually having no clinicians row at all. A doctor in B is the
-- strongest attacker available: if they are denied, only tenancy denied them.
--
-- The role field is also load-bearing for the browser. toVitalUser()
-- (components/auth-provider.tsx:62) returns null when user_metadata carries no
-- role, and AppGate then refuses the session -- the account would exist and be
-- unable to sign in.
--
-- Idempotent throughout. Re-running is safe and re-points anything that drifted.

do $$
declare
  -- The one literal to change if you used a different address. If the
  -- dashboard rejects this domain, any address you control works; nothing is
  -- ever sent to it.
  v_email     constant text := 'xtenant.b@vitalos.dev';

  v_hospital  constant text := 'vital-test-hospital';
  v_patient   constant text := 'pt-zz-xtenant-fixture';

  v_user_id   uuid;
  v_role      text;
begin
  ------------------------------------------------------------------------
  -- 1. The second tenant
  ------------------------------------------------------------------------
  insert into public.hospitals (id, name)
  values (v_hospital, 'VITAL Test Hospital (M3 fixture)')
  on conflict (id) do nothing;

  ------------------------------------------------------------------------
  -- 2. Locate the auth user
  --
  -- RAISES on absence, unlike the 0004 provisioning trigger, which never
  -- raises by design. Opposite requirements: the trigger must not block an
  -- auth write, whereas a fixture that silently seeds nothing produces a
  -- denial test that passes because there was nothing to deny.
  ------------------------------------------------------------------------
  select id into v_user_id from auth.users where email = v_email;

  if v_user_id is null then
    raise exception
      'VITAL-OS fixture: no auth.users row for %. Create the account in Authentication -> Users -> Add user before running this file.',
      v_email;
  end if;

  ------------------------------------------------------------------------
  -- 3. Check the trigger provisioned it, and that the role is right
  ------------------------------------------------------------------------
  select role into v_role from public.clinicians where id = v_user_id;

  if v_role is null then
    raise exception
      'VITAL-OS fixture: auth user % exists but has no clinicians row. The 0004 trigger swallows its own failures (RAISE WARNING, never EXCEPTION) -- look in Logs -> Postgres, then re-run supabase/migrations/0003_backfill_clinicians.sql.',
      v_email;
  end if;

  if v_role <> 'doctor' then
    raise exception
      'VITAL-OS fixture: clinician % has role %, expected doctor. A staff attacker is denied by the M2 role gate, which would make every stage-2 denial unattributable to RLS. Set {"role":"doctor"} in the user metadata -- the 0004 update trigger syncs it -- then re-run.',
      v_email, v_role;
  end if;

  ------------------------------------------------------------------------
  -- 4. Move the clinician into tenant B
  --
  -- Safe against later metadata edits: hospital_id is deliberately excluded
  -- from the ON CONFLICT DO UPDATE list in 0004, so tenancy is not
  -- reassignable through auth metadata and this will not be reverted.
  ------------------------------------------------------------------------
  update public.clinicians
     set hospital_id = v_hospital
   where id = v_user_id;

  ------------------------------------------------------------------------
  -- 5. A patient in tenant B
  --
  -- Named to be unmissable on purpose. Until RLS lands in stage 4 this row is
  -- visible in the tenant-A roster in the running app, and that visibility is
  -- the before-state the denial test exists to invert.
  --
  -- hospital_id is stated explicitly rather than defaulted -- the column
  -- default is 'vital-demo-hospital', which is the wrong tenant here.
  --
  -- discharged_at stays null so the row appears in the ACTIVE roster.
  -- fetchAllRows() filters discharged rows out, and a discharged fixture would
  -- be invisible for reasons unrelated to tenancy.
  ------------------------------------------------------------------------
  insert into public.patients (
    id, mrn, name, age, sex, room,
    chief_concern, acuity, status,
    hospital_id, clinician_id
  )
  values (
    v_patient,
    'MRN-XTENANT-B',
    'ZZ-XTENANT Test Patient',
    44,
    'F',
    'B-001',
    'Fixture row for the M3 cross-tenant denial test',
    'Stable',
    'Active',
    v_hospital,
    v_user_id
  )
  on conflict (id) do update
    set hospital_id   = excluded.hospital_id,
        clinician_id  = excluded.clinician_id,
        discharged_at = null;

  raise notice
    'VITAL-OS fixture applied. hospital=% clinician=% patient=%',
    v_hospital, v_user_id, v_patient;
end
$$;

-- Expected output: "Success. No rows returned", with the NOTICE above in the
-- SQL Editor's message pane. Any raise exception here is a real failure, not a
-- negative assertion -- stage 2 is where failures start meaning success.
