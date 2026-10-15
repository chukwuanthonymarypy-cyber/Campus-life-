-- Optional username/password accounts and optional verified recovery emails.
-- Apply AFTER 002 and 003. No persistent private-message inbox is created.
-- Only the Render service-role key may read or edit this table.
create table if not exists public.campus_usernames (
  username text primary key check (username ~ '^[a-z][a-z0-9_]{2,19}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  credential_email text not null,
  recovery_email text,
  recovery_verified_at timestamptz,
  recovery_pending_email text,
  verify_token_hash text,
  verify_expires_at timestamptz,
  reset_token_hash text,
  reset_expires_at timestamptz,
  created_at timestamptz not null default now()
);
-- Safe when upgrading a table created from an earlier local draft of 004.
alter table public.campus_usernames add column if not exists recovery_pending_email text;
alter table public.campus_usernames enable row level security;
revoke all on public.campus_usernames from anon,authenticated;
-- No anon/authenticated RLS policies or direct browser writes. All reads/writes
-- must come from the Render backend with its private service-role credential.
create index if not exists campus_usernames_recovery_idx
  on public.campus_usernames (lower(recovery_email)) where recovery_verified_at is not null;
