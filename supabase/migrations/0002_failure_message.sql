-- Provider/network failure detail. The failure code says what failed; this says why.
alter table task_results add column if not exists failure_message text;

-- Same idempotent save, with the failure message included.
create or replace function save_task_result(p_row jsonb)
returns void
language plpgsql
as $$
begin
  insert into task_results (
    run_id, task_id, fingerprint, attempt_id, attempt_no, model, provider, finish_reason,
    prompt_tokens, completion_tokens, duration_ms, failure_code, failure_message, rejected_items, payload
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
    p_row->>'failure_message',
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
    failure_message = excluded.failure_message,
    rejected_items = excluded.rejected_items,
    payload = excluded.payload
  where task_results.payload is null and excluded.payload is not null;
end;
$$;
