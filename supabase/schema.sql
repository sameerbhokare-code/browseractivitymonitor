-- Browser Activity Monitor, Phase 2 database schema.
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
--
-- Security model
-- * Every person has their own account (Supabase Auth, email + password).
-- * A browser registers itself as a device under that account.
-- * Activity rows are only readable by their owner, and by a viewer the owner
--   has explicitly authorized (share_grants), and only for visits made AFTER
--   that authorization. Revoking a grant hides everything from that viewer.
-- * Viewers create a short-lived invite code; the sharer types it into their
--   own extension, sees who the viewer is, and must click Authorize.

-- ---------- Tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  browser text check (char_length(browser) <= 30),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.activity (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  client_id text not null check (char_length(client_id) <= 64),
  domain text not null check (char_length(domain) between 1 and 253),
  visited_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (device_id, client_id)
);

create index if not exists activity_owner_time_idx
  on public.activity (owner_id, visited_at desc);

create table if not exists public.share_invites (
  code text primary key,
  viewer_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz
);

create table if not exists public.share_grants (
  id uuid primary key default gen_random_uuid(),
  sharer_id uuid not null references auth.users (id) on delete cascade,
  viewer_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (sharer_id, viewer_id),
  check (sharer_id <> viewer_id)
);

-- ---------- Profile created automatically on sign-up ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
                  split_part(new.email, '@', 1), 'User'), 60)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Helper used by the security rules ----------

-- True when the signed-in user has an active grant from p_owner that was
-- created at or before p_at.
create or replace function public.can_view(p_owner uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.share_grants g
    where g.sharer_id = p_owner
      and g.viewer_id = auth.uid()
      and g.revoked_at is null
      and g.created_at <= p_at
  );
$$;

-- ---------- Row Level Security ----------

alter table public.profiles      enable row level security;
alter table public.devices       enable row level security;
alter table public.activity      enable row level security;
alter table public.share_invites enable row level security;
alter table public.share_grants  enable row level security;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "devices: owner all"       on public.devices;
drop policy if exists "devices: viewer can read" on public.devices;
create policy "devices: owner all" on public.devices
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "devices: viewer can read" on public.devices
  for select to authenticated using (public.can_view(owner_id, now()));

drop policy if exists "activity: owner read"    on public.activity;
drop policy if exists "activity: owner insert"  on public.activity;
drop policy if exists "activity: owner delete"  on public.activity;
drop policy if exists "activity: viewer read"   on public.activity;
create policy "activity: owner read" on public.activity
  for select to authenticated using (owner_id = auth.uid());
create policy "activity: owner insert" on public.activity
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.devices d
                where d.id = device_id and d.owner_id = auth.uid())
  );
create policy "activity: owner delete" on public.activity
  for delete to authenticated using (owner_id = auth.uid());
create policy "activity: viewer read" on public.activity
  for select to authenticated using (public.can_view(owner_id, visited_at));

drop policy if exists "invites: viewer read own"   on public.share_invites;
drop policy if exists "invites: viewer delete own" on public.share_invites;
create policy "invites: viewer read own" on public.share_invites
  for select to authenticated using (viewer_id = auth.uid());
create policy "invites: viewer delete own" on public.share_invites
  for delete to authenticated using (viewer_id = auth.uid());

drop policy if exists "grants: parties can read" on public.share_grants;
create policy "grants: parties can read" on public.share_grants
  for select to authenticated
  using (sharer_id = auth.uid() or viewer_id = auth.uid());
-- No insert/update policies: grants change only through the functions below.

-- ---------- Sharing functions (called from the extension) ----------

-- Viewer: make a new 8 character invite code, valid for 24 hours.
create or replace function public.create_invite()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  new_code text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'You need to sign in first.';
  end if;

  delete from public.share_invites si
  where si.viewer_id = auth.uid() and (si.used_at is not null or si.expires_at < now());

  if (select count(*) from public.share_invites si where si.viewer_id = auth.uid()) >= 5 then
    raise exception 'You already have 5 active invite codes. Wait for them to expire.';
  end if;

  loop
    bytes := extensions.gen_random_bytes(8);
    new_code := '';
    for i in 0..7 loop
      new_code := new_code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
    end loop;
    begin
      insert into public.share_invites (code, viewer_id) values (new_code, auth.uid());
      exit;
    exception when unique_violation then
      -- extremely unlikely; try another code
    end;
  end loop;

  return query
    select si.code, si.expires_at from public.share_invites si where si.code = new_code;
end;
$$;

-- Sharer: look up who an invite code belongs to, before authorizing.
create or replace function public.preview_invite(p_code text)
returns table (viewer_name text, viewer_email text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.share_invites;
begin
  if auth.uid() is null then
    raise exception 'You need to sign in first.';
  end if;

  select * into inv from public.share_invites si where si.code = upper(trim(p_code));

  if inv.code is null or inv.used_at is not null or inv.expires_at < now() then
    raise exception 'This invite code is invalid or has expired.';
  end if;
  if inv.viewer_id = auth.uid() then
    raise exception 'This is your own invite code. Send it to the person who will share with you.';
  end if;

  return query
    select p.display_name, u.email::text, inv.expires_at
    from public.profiles p join auth.users u on u.id = p.id
    where p.id = inv.viewer_id;
end;
$$;

-- Sharer: explicitly authorize the viewer behind an invite code.
create or replace function public.accept_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.share_invites;
  grant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You need to sign in first.';
  end if;

  select * into inv from public.share_invites si
  where si.code = upper(trim(p_code))
  for update;

  if inv.code is null or inv.used_at is not null or inv.expires_at < now() then
    raise exception 'This invite code is invalid or has expired.';
  end if;
  if inv.viewer_id = auth.uid() then
    raise exception 'You cannot authorize yourself.';
  end if;

  insert into public.share_grants as g (sharer_id, viewer_id)
  values (auth.uid(), inv.viewer_id)
  on conflict (sharer_id, viewer_id)
  do update set revoked_at = null, created_at = now()
  returning g.id into grant_id;

  update public.share_invites si set used_at = now() where si.code = inv.code;

  return grant_id;
end;
$$;

-- Either side can end a share at any time.
create or replace function public.revoke_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.share_grants g
  set revoked_at = now()
  where g.id = p_grant_id
    and g.revoked_at is null
    and (g.sharer_id = auth.uid() or g.viewer_id = auth.uid());

  if not found then
    raise exception 'Share not found or already ended.';
  end if;
end;
$$;

-- Active shares in both directions, with the other person's id, name and email.
-- direction = 'outgoing': I share with them.  'incoming': they share with me.
-- (Dropped first because its columns changed in Phase 3.)
drop function if exists public.my_grants();
create function public.my_grants()
returns table (id uuid, direction text, other_id uuid, other_name text, other_email text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select g.id,
         case when g.sharer_id = auth.uid() then 'outgoing' else 'incoming' end,
         p.id,
         p.display_name,
         u.email::text,
         g.created_at
  from public.share_grants g
  join public.profiles p
    on p.id = case when g.sharer_id = auth.uid() then g.viewer_id else g.sharer_id end
  join auth.users u on u.id = p.id
  where g.revoked_at is null
    and (g.sharer_id = auth.uid() or g.viewer_id = auth.uid())
  order by g.created_at desc;
$$;

-- Only signed-in users may call the functions.
revoke execute on function public.create_invite()         from public, anon;
revoke execute on function public.preview_invite(text)    from public, anon;
revoke execute on function public.accept_invite(text)     from public, anon;
revoke execute on function public.revoke_grant(uuid)      from public, anon;
revoke execute on function public.my_grants()             from public, anon;
revoke execute on function public.can_view(uuid, timestamptz) from public, anon;
grant  execute on function public.create_invite()         to authenticated;
grant  execute on function public.preview_invite(text)    to authenticated;
grant  execute on function public.accept_invite(text)     to authenticated;
grant  execute on function public.revoke_grant(uuid)      to authenticated;
grant  execute on function public.my_grants()             to authenticated;
grant  execute on function public.can_view(uuid, timestamptz) to authenticated;
