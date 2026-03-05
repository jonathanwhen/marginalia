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
