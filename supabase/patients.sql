-- VITAL OS — patients table (demo; RLS off; anon access via publishable key)
-- Problems and symptoms are unified in the `problems` column only.

create table if not exists public.patients (
  id text primary key,
  mrn text not null,
  name text not null,
  age integer not null default 0,
  sex text not null default '?',
  dob date,
  blood_type text,
  last_visit date,
  provider text,
  room text,
  chief_concern text,
  acuity text,
  status text,
  allergies jsonb not null default '[]'::jsonb,
  medications jsonb not null default '[]'::jsonb,
  problems jsonb not null default '[]'::jsonb,
  emergency_contact jsonb not null default '{}'::jsonb,
  primary_contact_line text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint patients_mrn_unique unique (mrn)
);

comment on table public.patients is 'VITAL OS patient roster and chart data (demo)';
comment on column public.patients.problems is
  'Problems / symptoms (unified): [{ name, status, since }] — status: Active | Resolved | Monitoring | Pending | Ruled out';
comment on column public.patients.allergies is
  'Array of { allergen, reaction, severity }';
comment on column public.patients.medications is
  'Array of { name, dose, status }';
comment on column public.patients.emergency_contact is
  'Object { name, relationship, phone }';

create index if not exists patients_name_idx on public.patients (name);
create index if not exists patients_room_idx on public.patients (room);

create or replace function public.set_patients_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists patients_set_updated_at on public.patients;

create trigger patients_set_updated_at
before update on public.patients
for each row
execute function public.set_patients_updated_at();

alter table public.patients disable row level security;

grant select, insert, update, delete on table public.patients to anon;
grant select, insert, update, delete on table public.patients to authenticated;
