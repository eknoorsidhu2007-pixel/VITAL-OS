-- VITAL OS: remove symptoms column and reset problems to diagnoses-only
-- (matches the Problems section in the app — NOT demo symptom strings).
--
-- Run this entire script in Supabase SQL Editor, then restart: npm run dev

-- 1) Drop symptoms column if it still exists
ALTER TABLE public.patients DROP COLUMN IF EXISTS symptoms;

-- 2) Clear bad merged data (symptoms were mixed into problems)
TRUNCATE TABLE public.patients;

-- 3) Re-open VITAL OS in the browser.
--    The app auto-seeds 21 demo patients on first GET /api/patients.
--    Each patient's problems column will contain ONLY their diagnoses
--    (e.g. Adam Fraser = 2 problems, not 6).

COMMENT ON COLUMN public.patients.problems IS
  'Problems only (diagnoses): [{ name, status, since }]';

-- Optional: fix one patient without truncating everyone (Adam Fraser example)
-- UPDATE public.patients
-- SET problems = '[
--   {"name":"Acute pancreatitis suspected","status":"Active","since":"Chart"},
--   {"name":"Alcohol-related gastritis differential","status":"Active","since":"Chart"}
-- ]'::jsonb
-- WHERE id = 'pt-adam-fraser';
