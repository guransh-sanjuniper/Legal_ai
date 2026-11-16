-- Drafter drafts. A draft is the user's brief plus (from D2 onwards) the parsed particulars,
-- the source plan, the outline and the generated clauses. `data` holds those later stages so
-- they do not need a migration each time. Row level security is on from day one: each user
-- sees and changes only their own drafts.
--
-- The browser keeps the working copy in IndexedDB (`legal-drafter`) and pushes here best
-- effort. `id` is generated on the client; `user_id` defaults to the caller.

create table if not exists drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  instruction text not null default '',
  reference_doc_ids jsonb not null default '[]'::jsonb,
  reviewing_for text not null default 'neutral'
    check (reviewing_for in ('licensor', 'licensee', 'neutral')),
  -- Statuses are added by later stages, so no check constraint here.
  status text not null default 'brief',
  data jsonb not null default '{}'::jsonb,
  schema_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists drafts_user_updated on drafts (user_id, updated_at desc);

alter table drafts enable row level security;

drop policy if exists drafts_owner on drafts;
create policy drafts_owner on drafts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
