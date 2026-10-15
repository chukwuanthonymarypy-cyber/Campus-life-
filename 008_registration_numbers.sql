-- Apply after 006. Registration IDs are separate from player numbers used for admin grants.
-- Existing accounts are assigned IDs once; new accounts receive them automatically.
create sequence if not exists public.campus_registration_seq start with 1 increment by 1 no cycle;
create table if not exists public.campus_registration_numbers (
 user_id uuid primary key references auth.users(id) on delete cascade,
 registration_number text not null unique default ('SU-' || to_char(now() at time zone 'Africa/Lagos','YY') || '-' || lpad(nextval('public.campus_registration_seq')::text,7,'0')),
 created_at timestamptz not null default now(),
 constraint campus_registration_format check (registration_number ~ '^SU-[0-9]{2}-[0-9]{7,}$')
);
alter sequence public.campus_registration_seq owned by public.campus_registration_numbers.registration_number;
alter table public.campus_registration_numbers enable row level security;
create policy "Students read own registration number" on public.campus_registration_numbers
 for select to authenticated using ((select auth.uid())=user_id);
grant select on public.campus_registration_numbers to authenticated, service_role;
create or replace function public.campus_assign_registration_number() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 insert into public.campus_registration_numbers(user_id) values(new.id) on conflict(user_id) do nothing;
 return new;
end $$;
revoke all on function public.campus_assign_registration_number() from public;
drop trigger if exists campus_new_registration_number on auth.users;
create trigger campus_new_registration_number after insert on auth.users
 for each row execute function public.campus_assign_registration_number();
insert into public.campus_registration_numbers(user_id)
 select id from auth.users on conflict(user_id) do nothing;
