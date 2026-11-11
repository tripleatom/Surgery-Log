-- =====================================================================
-- Animal Surgery Log — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → Run (once).
-- =====================================================================

-- ---------- 1. Editors allowlist ------------------------------------
-- Anyone can sign in, but only emails listed here can add/edit records.
create table if not exists public.editors (
  email     text primary key,
  added_at  timestamptz not null default now()
);
alter table public.editors enable row level security;

create or replace function public.is_editor()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.editors
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_editor() to anon, authenticated;

-- Editors can see who else is an editor.
create policy "editors can read editor list"
  on public.editors for select to authenticated
  using (public.is_editor());

-- ---------- 2. Surgeries --------------------------------------------
-- One row per surgery. Targets (coordinates) and photos are JSON arrays,
-- because one surgery often has several implant / injection sites.
--
-- targets: [{region, hemisphere, ap, ml, dv, ref, dv_ref, angle_deg,
--            payload, volume_nl, histology}]
-- photos:  [{path, caption}]
create table if not exists public.surgeries (
  id                uuid primary key default gen_random_uuid(),
  animal_id         text not null,
  strain            text,
  sex               text check (sex in ('M', 'F') or sex is null),
  dob               date,
  weight_g          numeric,
  protocol          text,
  surgery_date      date not null,
  surgeon           text,
  surgery_type      text,
  device            text,
  anesthesia        text,
  analgesia         text,
  duration_min      integer,
  complications     text,
  status            text,
  outcome           text,
  notes             text,
  targets           jsonb not null default '[]'::jsonb,
  photos            jsonb not null default '[]'::jsonb,
  created_by        uuid default auth.uid() references auth.users (id),
  created_by_email  text default (auth.jwt() ->> 'email'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists surgeries_animal_idx on public.surgeries (animal_id);
create index if not exists surgeries_date_idx   on public.surgeries (surgery_date desc);

alter table public.surgeries enable row level security;

-- READ: public (anyone with the website link can view).
-- For lab-only viewing, drop this policy and use the commented one below.
create policy "public can read surgeries"
  on public.surgeries for select to anon, authenticated
  using (true);
-- create policy "editors can read surgeries"
--   on public.surgeries for select to authenticated
--   using (public.is_editor());

-- WRITE: editors only.
create policy "editors can add surgeries"
  on public.surgeries for insert to authenticated
  with check (public.is_editor() and created_by = auth.uid());

create policy "editors can update surgeries"
  on public.surgeries for update to authenticated
  using (public.is_editor()) with check (public.is_editor());

-- DELETE: only the person who created the record.
create policy "creator can delete own surgery"
  on public.surgeries for delete to authenticated
  using (public.is_editor() and created_by = auth.uid());

-- ---------- 3. Edit history (audit trail) ---------------------------
-- Every update/delete stores the previous version of the row.
create table if not exists public.surgery_history (
  id                bigserial primary key,
  surgery_id        uuid,
  action            text,
  old_row           jsonb,
  changed_by_email  text default (auth.jwt() ->> 'email'),
  changed_at        timestamptz not null default now()
);
alter table public.surgery_history enable row level security;
create policy "editors can read history"
  on public.surgery_history for select to authenticated
  using (public.is_editor());

create or replace function public.surgeries_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.surgery_history (surgery_id, action, old_row)
  values (old.id, lower(tg_op), to_jsonb(old));
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- creator fields are immutable; timestamp the edit
  new.created_by       := old.created_by;
  new.created_by_email := old.created_by_email;
  new.created_at       := old.created_at;
  new.updated_at       := now();
  return new;
end;
$$;

drop trigger if exists surgeries_audit on public.surgeries;
create trigger surgeries_audit
  before update or delete on public.surgeries
  for each row execute function public.surgeries_audit();

-- ---------- 4. Photo storage (PRIVATE) ------------------------------
-- The bucket is private: photos are only served (via short-lived signed URLs)
-- to signed-in editors and to emails on the photo_viewers list.
-- Records and coordinates stay public; photos do not.
create table if not exists public.photo_viewers (
  email     text primary key,
  added_at  timestamptz not null default now()
);
alter table public.photo_viewers enable row level security;

create or replace function public.can_view_photos()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_editor() or exists (
    select 1 from public.photo_viewers
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.can_view_photos() to anon, authenticated;

insert into storage.buckets (id, name, public)
values ('surgery-photos', 'surgery-photos', false)
on conflict (id) do update set public = false;

create policy "approved people can view photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'surgery-photos' and public.can_view_photos());

create policy "editors can upload photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'surgery-photos' and public.is_editor());

create policy "editors can delete photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'surgery-photos' and public.is_editor());

-- ---------- 5. Add people -------------------------------------------
-- Editors: can add/edit records AND view photos.
-- insert into public.editors (email) values
--   ('you@university.edu'),
--   ('labmate@university.edu');
--
-- Photo viewers: can view photos but not edit (e.g. collaborators, advisor).
-- insert into public.photo_viewers (email) values
--   ('collaborator@institute.org');
