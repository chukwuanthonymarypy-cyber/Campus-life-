-- Apply in a NEW Supabase project's SQL Editor before enabling the game integration.
-- Does not activate the older 001_accounts_inbox.sql schema or offline messaging.
create extension if not exists pgcrypto;

create table if not exists public.campus_avatar_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  avatar_path text check (avatar_path is null or avatar_path = user_id::text || '/avatar.jpg'),
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.campus_avatar_profiles enable row level security;
create policy "Anyone can see public avatar paths" on public.campus_avatar_profiles
  for select to anon, authenticated using (true);
create policy "Owners insert their own avatar" on public.campus_avatar_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners change their own avatar" on public.campus_avatar_profiles
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.campus_ads (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 60),
  link_url text not null check (link_url ~ '^https://[^[:space:]]+$'),
  asset_path text not null,
  board_ids text[] not null check (cardinality(board_ids) between 1 and 26),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  created_at timestamptz not null default now()
);
create index if not exists campus_ads_dates_idx on public.campus_ads(starts_on, ends_on);
alter table public.campus_ads enable row level security;
-- Only the Render server, using a private Supabase service-role key, writes/reads adverts.
-- Do not publish that key in Vercel or in an HTML file.

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('campus-avatars','campus-avatars',true,150000,array['image/jpeg']),
       ('campus-ads','campus-ads',true,300000,array['image/jpeg'])
on conflict(id) do update set public=true, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create policy "Avatar owners upload their picture" on storage.objects
  for insert to authenticated with check (bucket_id='campus-avatars' and name=(select auth.uid())::text || '/avatar.jpg');
create policy "Avatar owners read their own upload" on storage.objects
  for select to authenticated using (bucket_id='campus-avatars' and name=(select auth.uid())::text || '/avatar.jpg');
create policy "Avatar owners replace their picture" on storage.objects
  for update to authenticated using (bucket_id='campus-avatars' and name=(select auth.uid())::text || '/avatar.jpg')
  with check (bucket_id='campus-avatars' and name=(select auth.uid())::text || '/avatar.jpg');
create policy "Avatar owners delete their picture" on storage.objects
  for delete to authenticated using (bucket_id='campus-avatars' and name=(select auth.uid())::text || '/avatar.jpg');
