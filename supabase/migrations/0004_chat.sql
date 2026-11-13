-- General chat: sessions and their messages. Row level security is on: each user sees and
-- changes only their own sessions, and messages follow their session.

create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_sessions_user_updated on chat_sessions (user_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_created on chat_messages (session_id, created_at);

alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;

drop policy if exists chat_sessions_owner on chat_sessions;
create policy chat_sessions_owner on chat_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists chat_messages_owner on chat_messages;
create policy chat_messages_owner on chat_messages
  for all to authenticated
  using (exists (select 1 from chat_sessions s where s.id = chat_messages.session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from chat_sessions s where s.id = chat_messages.session_id and s.user_id = auth.uid()));
