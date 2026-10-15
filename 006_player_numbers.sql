-- Apply after 003 and 005. Eight-digit public-facing player numbers are lookup
-- identifiers, not passwords. Only owners may select their own mapping; only the
-- backend service role may resolve other players' numbers for administrator grants.
create sequence if not exists public.campus_player_number_seq start with 10000001 increment by 1 minvalue 10000001 maxvalue 99999999 no cycle;
create table if not exists public.campus_player_numbers (
 user_id uuid primary key references auth.users(id) on delete cascade,
 player_number bigint not null unique default nextval('public.campus_player_number_seq')
    check (player_number between 10000001 and 99999999),
 created_at timestamptz not null default now()
);
alter sequence public.campus_player_number_seq owned by public.campus_player_numbers.player_number;
alter table public.campus_player_numbers enable row level security;
create policy "Player reads own number" on public.campus_player_numbers for select to authenticated using ((select auth.uid())=user_id);
-- Grant select only to authenticated owners (via RLS) and to the trusted service.
grant select on public.campus_player_numbers to authenticated, service_role;
create or replace function public.campus_assign_player_number() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 insert into public.campus_player_numbers(user_id) values(new.id) on conflict(user_id) do nothing;
 return new;
end $$;
revoke all on function public.campus_assign_player_number() from public;
drop trigger if exists campus_new_player_number on auth.users;
create trigger campus_new_player_number after insert on auth.users for each row execute function public.campus_assign_player_number();
-- Assign numbers to accounts created before this migration.
insert into public.campus_player_numbers(user_id) select id from auth.users on conflict(user_id) do nothing;
