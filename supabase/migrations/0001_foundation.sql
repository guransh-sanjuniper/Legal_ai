-- Foundation tables for the pipeline harness. RLS is off (throwaway project).

create table if not exists runs (
  id uuid primary key,
  user_id uuid,
  doc_hash text not null,
  prep_fingerprint text not null,
  status text not null default 'running' check (status in ('running', 'complete', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  task_id text not null,
  fingerprint text not null,
  attempt_id text,
  attempt_no int,
  model text,
  provider text,
  finish_reason text,
  prompt_tokens int,
  completion_tokens int,
  duration_ms int,
  failure_code text,
  rejected_items int not null default 0,
  payload jsonb,
  created_at timestamptz not null default now(),
  constraint task_results_idempotency unique (task_id, fingerprint)
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id),
  body jsonb,
  coverage jsonb,
  created_at timestamptz not null default now()
);

create table if not exists rate_limits (
  user_id uuid not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (user_id, window_start)
);

-- One atomic statement: no read-then-write race.
create or replace function increment_rate_limit(p_user uuid, p_window timestamptz)
returns int
language sql
as $$
  insert into rate_limits (user_id, window_start, count)
  values (p_user, p_window, 1)
  on conflict (user_id, window_start)
  do update set count = rate_limits.count + 1
  returning count;
$$;

-- Idempotent save. A failure row (payload null) can be replaced by a later success row.
-- A success row is never overwritten, so retries cannot create duplicates.
create or replace function save_task_result(p_row jsonb)
returns void
language plpgsql
as $$
begin
  insert into task_results (
    run_id, task_id, fingerprint, attempt_id, attempt_no, model, provider, finish_reason,
    prompt_tokens, completion_tokens, duration_ms, failure_code, rejected_items, payload
  )
  values (
    (p_row->>'run_id')::uuid,
    p_row->>'task_id',
    p_row->>'fingerprint',
    p_row->>'attempt_id',
    (p_row->>'attempt_no')::int,
    p_row->>'model',
    p_row->>'provider',
    p_row->>'finish_reason',
    (p_row->>'prompt_tokens')::int,
    (p_row->>'completion_tokens')::int,
    (p_row->>'duration_ms')::int,
    p_row->>'failure_code',
    coalesce((p_row->>'rejected_items')::int, 0),
    nullif(p_row->'payload', 'null'::jsonb)
  )
  on conflict (task_id, fingerprint) do update set
    attempt_id = excluded.attempt_id,
    attempt_no = excluded.attempt_no,
    model = excluded.model,
    provider = excluded.provider,
    finish_reason = excluded.finish_reason,
    prompt_tokens = excluded.prompt_tokens,
    completion_tokens = excluded.completion_tokens,
    duration_ms = excluded.duration_ms,
    failure_code = excluded.failure_code,
    rejected_items = excluded.rejected_items,
    payload = excluded.payload
  where task_results.payload is null and excluded.payload is not null;
end;
$$;
