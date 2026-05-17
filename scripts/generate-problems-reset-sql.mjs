import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "lib", "demo-patients.ts"), "utf8");

const patients = [];
const blockRe = /\{\s*id:\s*"([^"]+)"[\s\S]*?diagnoses:\s*(\[[\s\S]*?\]),/g;
let m;
while ((m = blockRe.exec(src))) {
  const id = m[1];
  let diagnoses;
  try {
    diagnoses = Function(`"use strict"; return (${m[2]});`)();
  } catch {
    continue;
  }
  if (!Array.isArray(diagnoses)) continue;
  patients.push({ id, diagnoses });
}

const lines = [
  "-- Reset problems to diagnoses only (matches Problems section in app).",
  "-- Does NOT include demo symptoms.",
  "",
  "ALTER TABLE public.patients DROP COLUMN IF EXISTS symptoms;",
  "",
];

for (const { id, diagnoses } of patients) {
  const problems = diagnoses.map((name) => ({
    name,
    status: "Active",
    since: "Chart",
  }));
  const json = JSON.stringify(problems).replace(/'/g, "''");
  lines.push(
    `UPDATE public.patients SET problems = '${json}'::jsonb WHERE id = '${id}';`
  );
}

lines.push("");
lines.push(
  "-- Custom-admitted patients (id not in demo list): review problems manually in Table Editor."
);

writeFileSync(
  join(root, "supabase", "reset_problems_diagnoses_only.sql"),
  lines.join("\n"),
  "utf8"
);

console.log(`Wrote ${patients.length} patient updates.`);
