-- Atomic admission: only admitted requests increment the per-user window.
create or replace function admit_rate_limit(p_user uuid, p_window timestamptz, p_limit int)
returns int
language sql
as $$
  insert into rate_limits (user_id, window_start, count)
  values (p_user, p_window, 1)
  on conflict (user_id, window_start) do update
    set count = rate_limits.count + 1
    where rate_limits.count < p_limit
  returning count;
$$;

-- A rate-limited run pauses cleanly and can be resumed.
alter table runs drop constraint if exists runs_status_check;
alter table runs add constraint runs_status_check check (status in ('running', 'complete', 'cancelled', 'paused'));
alter table runs add column if not exists paused_reason text;
alter table runs add column if not exists retry_after timestamptz;
alter table runs add column if not exists rate_limit_events int not null default 0;
alter table runs add column if not exists rate_limit_wait_ms bigint not null default 0;
