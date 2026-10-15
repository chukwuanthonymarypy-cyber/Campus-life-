-- Apply AFTER 002_public_adverts_avatars.sql. This is the required account save store.
-- It does not enable the optional persistent private-message inbox.
create table if not exists public.campus_game_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object' and pg_column_size(state) < 250000),
  revision bigint not null default 1 check (revision > 0),
  admin_grants bigint not null default 0 check (admin_grants >= 0),
  updated_at timestamptz not null default now()
);
alter table public.campus_game_saves enable row level security;
create policy "Players read only their own game save" on public.campus_game_saves
  for select to authenticated using ((select auth.uid()) = user_id);
-- No direct client insert/update/delete policies. All writes use guarded functions.
-- admin_grants is a server-only ledger. state.stats.wallet stores the base balance
-- (which may be negative if a player spent some granted money); clients see the sum.
-- Browser gameplay is still client-trusted; the separate admin grant ledger is protected.

create or replace function public.campus_put_save(p_state jsonb, p_expected bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare current_user_id uuid := auth.uid(); new_revision bigint;
begin
  if current_user_id is null then raise exception 'Sign in before saving'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or pg_column_size(p_state) >= 250000
    then raise exception 'Save data is invalid or too large'; end if;
  if coalesce((p_state #>> '{stats,wallet}'),'') !~ '^[0-9]{1,16}$'
    or (p_state #>> '{stats,wallet}')::bigint > 9000000000000000
    then raise exception 'Save wallet is invalid'; end if;
  if p_expected = 0 then
    insert into public.campus_game_saves(user_id,state,revision) values(current_user_id,p_state,1)
    on conflict (user_id) do nothing returning revision into new_revision;
  elsif p_expected > 0 then
    update public.campus_game_saves
       set state=jsonb_set(p_state,'{stats,wallet}',
            to_jsonb((p_state #>> '{stats,wallet}')::bigint-admin_grants),true),
           revision=revision+1,updated_at=now()
     where user_id=current_user_id and revision=p_expected
    returning revision into new_revision;
  end if;
  if new_revision is null then raise exception 'CAMPUS_STALE_SAVE: another device has newer progress'; end if;
  return new_revision;
end $$;
revoke all on function public.campus_put_save(jsonb,bigint) from public;
grant execute on function public.campus_put_save(jsonb,bigint) to authenticated;

create or replace function public.campus_admin_credit(p_user_id uuid, p_amount integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare updated_state jsonb; updated_revision bigint; updated_wallet bigint;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Administrator service only'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then raise exception 'Invalid top-up amount'; end if;
  update public.campus_game_saves
     set admin_grants=admin_grants+p_amount,revision=revision+1,updated_at=now()
   where user_id=p_user_id and
     coalesce((state #>> '{stats,wallet}')::bigint,0)+admin_grants+p_amount <= 9000000000000000
  returning state,revision,admin_grants into updated_state,updated_revision,updated_wallet;
  if updated_revision is null then raise exception 'Player has no account save or balance is too high'; end if;
  updated_wallet=(updated_state #>> '{stats,wallet}')::bigint+updated_wallet;
  return jsonb_build_object('revision',updated_revision,'wallet',updated_wallet);
end $$;
revoke all on function public.campus_admin_credit(uuid,integer) from public;
grant execute on function public.campus_admin_credit(uuid,integer) to service_role;
