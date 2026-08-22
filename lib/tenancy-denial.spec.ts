/**
 * VITAL OS — cross-tenant denial test (Milestone 3)
 *
 * Commit path: lib/tenancy-denial.spec.ts
 *
 *   npm run test:tenancy:open     stage 2 — before RLS. Asserts every denial
 *                                 probe is ALLOWED. A green run here means the
 *                                 hole is real and the baseline is honest.
 *
 *   npm run test:tenancy          stage 4 — after RLS. Asserts every denial
 *                                 probe is DENIED. A green run here means the
 *                                 policies work.
 *
 * DELIBERATELY OUTSIDE `npm test`. The other three suites are hermetic —
 * stubbed fetch, no network, no env, no database. This one needs .env.tenancy,
 * a live project, and the stage-1 fixture; folding it into the default chain
 * would make a green build depend on all three and break it for anyone else.
 *
 * WHY THE MODE FLAG EXISTS. Every assertion below is negative, so in stage 2
 * every one of them "passes" by being allowed — output that reads like total
 * failure. Declaring the expected state per run makes both directions
 * meaningful: stage 2 fails loudly if something is ALREADY denied (which would
 * mean the baseline is contaminated and the stage-4 comparison proves nothing),
 * and stage 4 fails loudly if anything is still allowed.
 *
 * WHAT THIS FILE DOES NOT COVER. Route handlers. createServerSupabase() reads
 * auth from cookies only — there is no Authorization-header path — so a Node
 * process cannot authenticate against /api/*. Route-level cross-tenant
 * behaviour is checked from the DevTools console instead; see the stage-2
 * console block in the session notes. The assertions here talk to PostgREST
 * directly, which is the layer the M2 role gate never protected and the layer
 * RLS actually governs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Fixture constants — must match supabase/fixtures/0006_cross_tenant_fixture.sql
// ---------------------------------------------------------------------------

const DEMO_HOSPITAL = "vital-demo-hospital";
const TEST_HOSPITAL = "vital-test-hospital";
const FIXTURE_PATIENT = "pt-zz-xtenant-fixture";

/** Written by tenant A into tenant A. Legitimate; proves same-tenant writes survive RLS. */
const PROBE_A = "pt-zz-denial-probe-a";
/** Written by tenant B into tenant A. The forgery. Must stop existing in stage 4. */
const PROBE_B_INTO_A = "pt-zz-denial-probe-b-into-a";

// ---------------------------------------------------------------------------
// Credentials, from outside the repo
// ---------------------------------------------------------------------------

const OPS_ENV =
  process.env.VITAL_OPS_ENV ??
  path.join(os.homedir(), "vital-os-ops", ".env.tenancy");

/** Minimal KEY=VALUE reader. No dotenv dependency added for one file. */
function loadOpsEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Credentials file not found: ${file}\n` +
        `Create it (see stage 1, step 3) or point VITAL_OPS_ENV at it.\n` +
        `It stays outside the repo deliberately — it holds two live passwords.`
    );
  }
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key} in ${OPS_ENV}`);
  return value;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Mode = "open" | "closed";
type State = "allowed" | "denied";
type Outcome = { state: State; detail: string };

const mode: Mode = process.argv.includes("--expect=closed") ? "closed" : "open";

let failures = 0;

/**
 * A cross-tenant probe. Expected ALLOWED before RLS, DENIED after.
 *
 * `expected` is printed on every line, passing or failing, because the whole
 * milestone is negative assertions and an unlabelled "allowed" is unreadable.
 */
function denial(id: string, label: string, outcome: Outcome): void {
  const expected: State = mode === "open" ? "allowed" : "denied";
  const ok = outcome.state === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${id}  ${outcome.state.toUpperCase().padEnd(7)} ${label}`
  );
  console.log(`         ${outcome.detail}`);
  if (!ok) {
    console.log(
      mode === "open"
        ? `         EXPECTED allowed. Something is already denying this with RLS off — ` +
            `the baseline is contaminated and the stage-4 comparison proves nothing. Stop here.`
        : `         EXPECTED denied. The policy does not cover this path.`
    );
  }
}

/**
 * A same-tenant probe. Expected ALLOWED in BOTH runs.
 *
 * These are what catch an over-broad policy in stage 4: a rule that denies
 * cross-tenant access can just as easily deny everything, and every negative
 * assertion above would still go green.
 */
function guard(id: string, label: string, outcome: Outcome): void {
  const ok = outcome.state === "allowed";
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${id}  ${outcome.state.toUpperCase().padEnd(7)} ${label}`
  );
  console.log(`         ${outcome.detail}`);
  if (!ok) {
    console.log(
      `         EXPECTED allowed in both runs. Same-tenant access is broken — ` +
        `the policy is too narrow, or the caller has no clinicians row.`
    );
  }
}

/**
 * Classify a PostgREST read.
 *
 * A SELECT denied by a USING clause is NOT an error — it returns 200 with an
 * empty array. Row count is the signal, not status.
 */
function fromRows(
  error: { code?: string; message?: string } | null,
  data: unknown[] | null,
  noun: string
): Outcome {
  if (error) {
    return {
      state: "denied",
      detail: `error ${error.code ?? "?"}: ${error.message ?? "(no message)"}`,
    };
  }
  const n = data?.length ?? 0;
  return n > 0
    ? { state: "allowed", detail: `${n} ${noun} returned` }
    : { state: "denied", detail: `0 ${noun} returned` };
}

/**
 * Classify a PostgREST write.
 *
 * Two distinct denial shapes, and only one of them is an error:
 *   - USING excludes the row      -> 200, zero rows affected, no error
 *   - WITH CHECK rejects the row  -> 403, SQLSTATE 42501
 * Asserting on status alone would score the first as a pass.
 */
function fromWrite(
  error: { code?: string; message?: string } | null,
  data: unknown[] | null
): Outcome {
  if (error) {
    const rls = error.code === "42501";
    return {
      state: "denied",
      detail: rls
        ? `refused by RLS (42501): ${error.message ?? ""}`.trim()
        : `error ${error.code ?? "?"}: ${error.message ?? "(no message)"}`,
    };
  }
  const n = data?.length ?? 0;
  return n > 0
    ? { state: "allowed", detail: `${n} row(s) written and returned` }
    : { state: "denied", detail: `0 rows affected (row invisible to the write)` };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function signIn(
  url: string,
  key: string,
  email: string,
  password: string,
  who: string
): Promise<SupabaseClient> {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(
      `Sign-in failed for ${who} (${email}): ${error.message}\n` +
        `Check the credentials in ${OPS_ENV}.`
    );
  }
  return client;
}

async function run(): Promise<void> {
  const env = loadOpsEnv(OPS_ENV);
  const url = required(env, "NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");

  console.log(`tenancy-denial — expecting RLS to be ${mode.toUpperCase()}`);
  console.log(`credentials: ${OPS_ENV}\n`);

  const A = await signIn(
    url,
    anonKey,
    required(env, "TENANT_A_EMAIL"),
    required(env, "TENANT_A_PASSWORD"),
    "tenant A doctor"
  );
  const B = await signIn(
    url,
    anonKey,
    required(env, "TENANT_B_EMAIL"),
    required(env, "TENANT_B_PASSWORD"),
    "tenant B doctor"
  );
  /** No session. Exercises the `anon` role, which is what a browser holds. */
  const ANON = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -------------------------------------------------------------------------
  // Preconditions. Not assertions — aborts.
  //
  // Handoff v5: "a test can pass for the wrong reason". Every denial below is
  // satisfied by an empty table, so the targets have to be proven present
  // first. Both queries are tenant-local, so they hold in open and closed runs
  // alike.
  // -------------------------------------------------------------------------
  const { data: aOwn, error: aOwnErr } = await A.from("patients")
    .select("id")
    .eq("hospital_id", DEMO_HOSPITAL)
    .limit(5);
  if (aOwnErr || !aOwn?.length) {
    throw new Error(
      `Precondition failed: tenant A can see no patients in ${DEMO_HOSPITAL}. ` +
        `Nothing for tenant B to be denied. ${aOwnErr?.message ?? ""}`
    );
  }

  const { data: bOwn, error: bOwnErr } = await B.from("patients")
    .select("id, hospital_id")
    .eq("id", FIXTURE_PATIENT)
    .maybeSingle();
  if (bOwnErr || !bOwn) {
    throw new Error(
      `Precondition failed: fixture patient ${FIXTURE_PATIENT} not visible to tenant B. ` +
        `Re-run supabase/fixtures/0006_cross_tenant_fixture.sql. ${bOwnErr?.message ?? ""}`
    );
  }
  if (bOwn.hospital_id !== TEST_HOSPITAL) {
    throw new Error(
      `Precondition failed: ${FIXTURE_PATIENT} is in ${bOwn.hospital_id}, expected ${TEST_HOSPITAL}. ` +
        `A previous run left D4 un-restored. Re-run the fixture.`
    );
  }

  const targetA = aOwn[0].id as string;
  console.log(`  preconditions ok — tenant A target: ${targetA}\n`);

  try {
    // -----------------------------------------------------------------------
    // D1 — read across tenants
    // -----------------------------------------------------------------------
    {
      const { data, error } = await B.from("patients")
        .select("id, name, hospital_id")
        .eq("hospital_id", DEMO_HOSPITAL);
      denial(
        "D1",
        "tenant B reads tenant A's patients",
        fromRows(error, data, "patients")
      );
    }

    // -----------------------------------------------------------------------
    // D2 — write across tenants
    //
    // `room` rather than a clinical field on purpose: isRestrictedClinicalPatch
    // is a route-layer check and does not exist down here, but keeping the
    // probe off clinical columns means a stray allowed write never lands in a
    // problem list or a medication list.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await B.from("patients")
        .update({ room: "XTENANT-PROBE" })
        .eq("id", targetA)
        .select("id, room");
      denial(
        "D2",
        "tenant B updates a tenant A patient",
        fromWrite(error, data)
      );
    }

    // -----------------------------------------------------------------------
    // D3 — insert into another tenant
    // -----------------------------------------------------------------------
    {
      const { data, error } = await B.from("patients")
        .insert({
          id: PROBE_B_INTO_A,
          mrn: "MRN-XTENANT-PROBE",
          name: "ZZ-PROBE Forged Admission",
          hospital_id: DEMO_HOSPITAL,
        })
        .select("id, hospital_id");
      denial(
        "D3",
        "tenant B inserts a patient into tenant A",
        fromWrite(error, data)
      );
    }

    // -----------------------------------------------------------------------
    // D4 — move your own patient into another tenant
    //
    // The mutable-hospital_id gap 0005 left open. patients holds a table-level
    // UPDATE grant, which implies UPDATE on every column including this one,
    // and a column-level revoke cannot remove it — verified in M2 against
    // information_schema.column_privileges. The stage-3 WITH CHECK is the fix.
    //
    // Restored in cleanup either way. If this is ever left un-restored the
    // fixture patient belongs to tenant A and every later run fails its
    // preconditions.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await B.from("patients")
        .update({ hospital_id: DEMO_HOSPITAL })
        .eq("id", FIXTURE_PATIENT)
        .select("id, hospital_id");
      denial(
        "D4",
        "tenant B moves its own patient into tenant A",
        fromWrite(error, data)
      );
    }

    // -----------------------------------------------------------------------
    // D5 — read another tenant's clinicians
    //
    // Disclosure rather than escalation — clinicians is SELECT-only to
    // authenticated — but it is names and roles across every tenant, and 0002
    // records it as exactly what this test was written to catch.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await B.from("clinicians")
        .select("id, role, full_name, hospital_id")
        .eq("hospital_id", DEMO_HOSPITAL);
      denial(
        "D5",
        "tenant B reads tenant A's clinicians",
        fromRows(error, data, "clinicians")
      );
    }

    // -----------------------------------------------------------------------
    // D6 — signed out, straight at PostgREST
    //
    // The one that matters most. The M2 role gate covers /api/*; it does
    // nothing about a browser calling /rest/v1/patients with the publishable
    // key, which ships to every visitor via NEXT_PUBLIC_SUPABASE_ANON_KEY.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await ANON.from("patients").select("id, name, hospital_id");
      denial(
        "D6",
        "anon (signed out) reads the whole patients table",
        fromRows(error, data, "patients")
      );
    }

    // -----------------------------------------------------------------------
    // D7 — signed out, writing
    // -----------------------------------------------------------------------
    {
      const { data, error } = await ANON.from("patients")
        .update({ room: "ANON-PROBE" })
        .eq("id", targetA)
        .select("id");
      denial("D7", "anon (signed out) updates a patient", fromWrite(error, data));
    }

    // -----------------------------------------------------------------------
    // D8 — reverse direction
    //
    // Symmetry is not free. A predicate written against the wrong side of the
    // join denies one direction and allows the other, and D1-D7 would all
    // still be green.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await A.from("patients")
        .select("id, hospital_id")
        .eq("id", FIXTURE_PATIENT);
      denial(
        "D8",
        "tenant A reads tenant B's fixture patient",
        fromRows(error, data, "patients")
      );
    }

    // -----------------------------------------------------------------------
    // G1-G4 — same-tenant guards. Allowed in BOTH runs.
    // -----------------------------------------------------------------------
    {
      const { data, error } = await A.from("patients")
        .select("id")
        .eq("hospital_id", DEMO_HOSPITAL);
      guard("G1", "tenant A reads its own roster", fromRows(error, data, "patients"));
    }

    {
      const { data, error } = await A.from("patients")
        .insert({
          id: PROBE_A,
          mrn: "MRN-PROBE-A",
          name: "ZZ-PROBE Same Tenant",
        })
        .select("id, hospital_id");
      guard("G2", "tenant A admits into its own tenant", fromWrite(error, data));
    }

    {
      const { data, error } = await A.from("patients")
        .update({ room: "A-PROBE" })
        .eq("id", PROBE_A)
        .select("id, room");
      guard("G3", "tenant A updates its own patient", fromWrite(error, data));
    }

    {
      // The seeder guard. seedDemoPatientsIfEmpty() (lib/patient-store.ts:44)
      // head-counts patients on every roster fetch and seeds when the count is
      // zero — and the rows it inserts never mention hospital_id, so they take
      // the demo-tenant default and will be refused by the stage-3 WITH CHECK.
      // A tenant that can see nothing gets a 500 roster, not an empty one.
      const { data, error } = await B.from("patients").select("id").limit(1);
      guard(
        "G4",
        "tenant B sees at least one patient (keeps the demo seeder from firing)",
        fromRows(error, data, "patients")
      );
    }
  } finally {
    await cleanup(A, B);
  }

  console.log("");
  if (failures === 0) {
    console.log(
      mode === "open"
        ? `PASS — every cross-tenant probe was ALLOWED. The hole is real and the ` +
            `baseline is honest. Re-run with npm run test:tenancy after enabling RLS; ` +
            `every D-line must flip to DENIED and every G-line must stay ALLOWED.`
        : `PASS — every cross-tenant probe was DENIED and every same-tenant guard ` +
            `still ALLOWED. Now run the full M2 live sequence: roster, admit, chart ` +
            `edit, discharge, voice.`
    );
  } else {
    console.log(`FAIL — ${failures} assertion(s) did not match expectations.`);
    process.exitCode = 1;
  }
}

/**
 * Undo everything the probes wrote.
 *
 * Runs in `finally`, so a mid-run throw still restores the fixture. Every step
 * is best-effort and reports rather than throwing: a cleanup exception would
 * mask the assertion failure that caused it.
 */
async function cleanup(A: SupabaseClient, B: SupabaseClient): Promise<void> {
  console.log("\n  cleanup");

  // D4's restore comes first. Everything else is disposable; this row is the
  // fixture, and leaving it in tenant A breaks the next run's preconditions.
  const { error: restoreErr } = await B.from("patients")
    .update({ hospital_id: TEST_HOSPITAL })
    .eq("id", FIXTURE_PATIENT);
  if (restoreErr) {
    console.log(`         restore ${FIXTURE_PATIENT}: ${restoreErr.message}`);
  }

  const { data: check } = await B.from("patients")
    .select("hospital_id")
    .eq("id", FIXTURE_PATIENT)
    .maybeSingle();
  const restored = check?.hospital_id === TEST_HOSPITAL;
  console.log(
    restored
      ? `    ok   ${FIXTURE_PATIENT} back in ${TEST_HOSPITAL}`
      : `    FAIL ${FIXTURE_PATIENT} is in ${check?.hospital_id ?? "(not visible)"} — ` +
          `re-run supabase/fixtures/0006_cross_tenant_fixture.sql before the next run`
  );
  if (!restored) failures += 1;

  // Probe rows. Tenant A can reach both while RLS is off; once it is on, D3's
  // row was never created, so A's delete covering PROBE_A is enough.
  for (const id of [PROBE_A, PROBE_B_INTO_A]) {
    await A.from("patients").delete().eq("id", id);
    await B.from("patients").delete().eq("id", id);
    const { data } = await A.from("patients").select("id").eq("id", id);
    console.log(
      data?.length
        ? `    warn ${id} still present — delete it by hand`
        : `    ok   ${id} removed`
    );
  }

  // D2 and D7 wrote `room` on a real demo patient. Nothing here knows the
  // original value, and inventing one would be worse than leaving the probe
  // string visible — it is obvious in the UI and harmless.
  console.log(
    `    note any patient showing room XTENANT-PROBE or ANON-PROBE was written by D2/D7`
  );
}

run().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
