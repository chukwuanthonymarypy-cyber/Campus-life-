-- Apply AFTER 006_player_numbers.sql and 008_registration_numbers.sql.
-- Server-only population and exclusive A/B room claims. Do NOT apply 001_accounts_inbox.sql.
-- The shared classic hostel is communal; floor/unit addresses in the residence towers are exclusive.
create table if not exists public.campus_guest_registry (
  guest_id text primary key check (guest_id ~ '^SU-G-[A-F0-9]{12}$'),
  first_seen_at timestamptz not null default now()
);
alter table public.campus_guest_registry enable row level security;
revoke all on public.campus_guest_registry from anon, authenticated;

create table if not exists public.campus_room_leases (
  kind text not null check (kind in ('crescentHostel','campusMaple','campusCedar','campusUnity','campusSummit','lodgeWest','lodgeEast','oakTower','riverTower','unityTower','eastTower')),
  floor smallint not null check (floor between 1 and 5),
  unit text not null check (unit in ('A','B')),
  owner_key text not null unique check (owner_key ~ '^(a:[0-9a-f-]{36}|g:SU-G-[A-F0-9]{12})$'),
  paid_through_day integer not null check (paid_through_day between 1 and 1000000),
  expires_at timestamptz not null default (now() + interval '180 days'),
  updated_at timestamptz not null default now(),
  primary key (kind,floor,unit)
);
alter table public.campus_room_leases enable row level security;
revoke all on public.campus_room_leases from anon, authenticated;

create or replace function public.campus_room_claim(p_owner text,p_kind text,p_floor integer,p_unit text,p_paid_through integer,p_previous_owner text default null)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service only'; end if;
  if p_owner !~ '^(a:[0-9a-f-]{36}|g:SU-G-[A-F0-9]{12})$'
    or p_kind not in ('crescentHostel','campusMaple','campusCedar','campusUnity','campusSummit','lodgeWest','lodgeEast','oakTower','riverTower','unityTower','eastTower')
    or p_floor not between 1 and 5 or p_unit not in ('A','B')
    or p_paid_through not between 1 and 1000000 then raise exception 'Invalid room claim'; end if;
  if p_previous_owner is not null and (p_owner !~ '^a:[0-9a-f-]{36}$' or p_previous_owner !~ '^g:SU-G-[A-F0-9]{12}$') then raise exception 'Invalid guest transfer'; end if;
  lock table public.campus_room_leases in share row exclusive mode;
  delete from public.campus_room_leases where expires_at <= now();
  if exists (select 1 from public.campus_room_leases where kind=p_kind and floor=p_floor and unit=p_unit and owner_key<>p_owner and (p_previous_owner is null or owner_key<>p_previous_owner)) then return false; end if;
  delete from public.campus_room_leases where owner_key=p_owner and (kind,floor,unit)<>(p_kind,p_floor,p_unit);
  if p_previous_owner is not null then delete from public.campus_room_leases where owner_key=p_previous_owner; end if;
  insert into public.campus_room_leases(kind,floor,unit,owner_key,paid_through_day,expires_at)
    values(p_kind,p_floor,p_unit,p_owner,p_paid_through,now()+interval '180 days')
    on conflict(kind,floor,unit) do update set paid_through_day=excluded.paid_through_day,
      expires_at=excluded.expires_at,updated_at=now() where campus_room_leases.owner_key=p_owner;
  return true;
end $$;
revoke all on function public.campus_room_claim(text,text,integer,text,integer,text) from public;
grant execute on function public.campus_room_claim(text,text,integer,text,integer,text) to service_role;

create or replace function public.campus_room_release(p_owner text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service only'; end if;
  delete from public.campus_room_leases where owner_key=p_owner;
end $$;
revoke all on function public.campus_room_release(text) from public;
grant execute on function public.campus_room_release(text) to service_role;

create or replace function public.campus_population_totals()
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service only'; end if;
  return jsonb_build_object('registered', (select count(*) from public.campus_player_numbers),
                            'guests', (select count(*) from public.campus_guest_registry));
end $$;
revoke all on function public.campus_population_totals() from public;
grant execute on function public.campus_population_totals() to service_role;
