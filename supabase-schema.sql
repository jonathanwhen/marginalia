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
