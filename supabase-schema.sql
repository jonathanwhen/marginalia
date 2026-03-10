-- Marginalia sharing schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Profiles table (linked to Supabase auth)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null default '',
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "Public profiles are viewable by everyone"
  on profiles for select using (true);

create policy "Users can update their own profile"
  on profiles for update using (auth.uid() = id);

create policy "Users can insert their own profile"
  on profiles for insert with check (auth.uid() = id);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- 2. Shared pages table
create table shared_pages (
  id uuid primary key default gen_random_uuid(),
  share_code text unique not null,
  user_id uuid references profiles(id) on delete cascade not null,
  page_key text not null,
  title text not null default '',
  author text default '',
  url text default '',
  notes text default '',
  tags text[] default '{}',
  highlights jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table shared_pages enable row level security;

-- Anyone can view shared pages (that's the whole point)
create policy "Shared pages are viewable by everyone"
  on shared_pages for select using (true);

-- Only the owner can create/update/delete their shares
create policy "Users can create their own shares"
  on shared_pages for insert with check (auth.uid() = user_id);

create policy "Users can update their own shares"
  on shared_pages for update using (auth.uid() = user_id);

create policy "Users can delete their own shares"
  on shared_pages for delete using (auth.uid() = user_id);

-- Index for fast share_code lookups
create index idx_shared_pages_share_code on shared_pages (share_code);

-- Index for user's shares listing
create index idx_shared_pages_user_id on shared_pages (user_id);

-- 3. Library PDF sync
-- Tracks which PDFs each user has in Supabase Storage so Chrome and Electron
-- can sync their libraries automatically.

create table library_pdfs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  page_key text not null,
  file_hash text not null default '',
  byte_size integer not null default 0,
  title text default '',
  author text default '',
  file_name text default '',
  page_count integer default 0,
  word_count integer default 0,
  tags text[] default '{}',
  storage_path text not null,
  uploaded_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, page_key)
);

alter table library_pdfs enable row level security;

create policy "Users can view their own PDFs"
  on library_pdfs for select using (auth.uid() = user_id);

create policy "Users can insert their own PDFs"
  on library_pdfs for insert with check (auth.uid() = user_id);

create policy "Users can update their own PDFs"
  on library_pdfs for update using (auth.uid() = user_id);

create policy "Users can delete their own PDFs"
  on library_pdfs for delete using (auth.uid() = user_id);

create index idx_library_pdfs_user_id on library_pdfs (user_id);

-- Storage bucket for PDF files (private, per-user folders)
-- Path format: {user_id}/{file_hash}-{byte_size}.pdf
insert into storage.buckets (id, name, public) values ('library', 'library', false);

create policy "library_insert" on storage.objects for insert with check (
  bucket_id = 'library' and auth.uid()::text = split_part(name, '/', 1)
);

create policy "library_select" on storage.objects for select using (
  bucket_id = 'library' and auth.uid()::text = split_part(name, '/', 1)
);

create policy "library_update" on storage.objects for update using (
  bucket_id = 'library' and auth.uid()::text = split_part(name, '/', 1)
);

create policy "library_delete" on storage.objects for delete using (
  bucket_id = 'library' and auth.uid()::text = split_part(name, '/', 1)
);

-- 4. Readings sync (cross-device)
create table if not exists synced_readings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  page_key text not null,
  data jsonb not null,
  updated_at timestamptz default now() not null,
  unique(user_id, page_key)
);

alter table synced_readings enable row level security;
create policy "Users manage own readings" on synced_readings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 5. Highlights sync (cross-device)
create table if not exists synced_highlights (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  page_key text not null,
  highlights jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now() not null,
  unique(user_id, page_key)
);

alter table synced_highlights enable row level security;
create policy "Users manage own highlights" on synced_highlights
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Indexes for efficient queries
create index if not exists idx_synced_readings_user on synced_readings(user_id);
create index if not exists idx_synced_highlights_user on synced_highlights(user_id);

-- 6. Collaborative annotation pages
create table if not exists collab_pages (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users(id) on delete cascade not null,
  page_key text not null,
  page_url text,
  page_title text,
  invite_code text unique not null default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz default now() not null
);

alter table collab_pages enable row level security;
create policy "Owners manage collab pages" on collab_pages
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "Members can read collab pages" on collab_pages
  for select using (
    id in (select collab_page_id from collab_members where user_id = auth.uid())
  );
-- Allow authenticated users to look up collab pages by invite_code (needed for joining)
create policy "Authenticated users can lookup by invite code" on collab_pages
  for select using (auth.role() = 'authenticated');

-- Collab page members
create table if not exists collab_members (
  id uuid default gen_random_uuid() primary key,
  collab_page_id uuid references collab_pages(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  display_name text,
  joined_at timestamptz default now() not null,
  unique(collab_page_id, user_id)
);

alter table collab_members enable row level security;
create policy "Members can read members" on collab_members
  for select using (
    collab_page_id in (
      select id from collab_pages where owner_id = auth.uid()
      union
      select collab_page_id from collab_members where user_id = auth.uid()
    )
  );
create policy "Users can join" on collab_members
  for insert with check (auth.uid() = user_id);

-- Collaborative annotations
create table if not exists collab_annotations (
  id uuid default gen_random_uuid() primary key,
  collab_page_id uuid references collab_pages(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  display_name text,
  highlight jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table collab_annotations enable row level security;
create policy "Members can read annotations" on collab_annotations
  for select using (
    collab_page_id in (
      select id from collab_pages where owner_id = auth.uid()
      union
      select collab_page_id from collab_members where user_id = auth.uid()
    )
  );
create policy "Users manage own annotations" on collab_annotations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Indexes for collab tables
create index idx_collab_pages_owner on collab_pages (owner_id);
create index idx_collab_pages_invite on collab_pages (invite_code);
create index idx_collab_pages_page_key on collab_pages (page_key);
create index idx_collab_members_page on collab_members (collab_page_id);
create index idx_collab_members_user on collab_members (user_id);
create index idx_collab_annotations_page on collab_annotations (collab_page_id);

-- Enable realtime for collab annotations
alter publication supabase_realtime add table collab_annotations;
