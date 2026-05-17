-- DEPRECATED — do not use. Symptoms are not stored in the database.
-- Use reset_problems_diagnoses_only.sql instead.

ALTER TABLE public.patients DROP COLUMN IF EXISTS symptoms;
