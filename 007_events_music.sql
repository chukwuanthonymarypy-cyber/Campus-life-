-- Apply after 006. Admin-only writes use server-side service credentials.
create table if not exists public.campus_events (
 id uuid primary key,
 title text not null check (char_length(title) between 3 and 80),
 details text not null default '' check (char_length(details) <= 500),
 starts_at timestamptz not null,
 location_id text,
 created_at timestamptz not null default now()
);
alter table public.campus_events enable row level security;
create table if not exists public.campus_music (
 id uuid primary key,
 title text not null check (char_length(title) between 2 and 80),
 asset_path text not null unique,
 location_id text,
 radio boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.campus_music enable row level security;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
 values ('campus-music','campus-music',true,8388608,array['audio/mpeg','audio/ogg','audio/mp4'])
 on conflict (id) do update set public=true,file_size_limit=8388608,allowed_mime_types=array['audio/mpeg','audio/ogg','audio/mp4'];
-- Storage public downloads are enabled by the public bucket. Upload/delete only
-- through the server's service role; no anonymous or authenticated write policy.
