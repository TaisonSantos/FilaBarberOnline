begin;

-- The public queue and its Realtime broadcast should not expose a customer's
-- full name. Keep the existing RPC contract while showing only the first name.
create or replace function public.get_public_queue()
returns table (
  queue_entry_id uuid,
  display_name text,
  service_name text,
  status text,
  "position" bigint,
  people_ahead bigint,
  estimated_wait_minutes integer,
  started_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with queue_rows as (
    select
      q.id,
      coalesce(nullif(split_part(btrim(c.name), ' ', 1), ''), 'Cliente') as display_name,
      q.service_name_snapshot,
      q.status,
      q.position_order,
      q.started_at,
      case
        when q.status = 'serving' and q.started_at is not null then
          greatest(
            q.service_duration_minutes_snapshot
              - floor(extract(epoch from (statement_timestamp() - q.started_at)) / 60)::integer,
            0
          )
        else q.service_duration_minutes_snapshot
      end as remaining_minutes
    from public.queue_entries q
    join public.clients c on c.id = q.client_id
    where q.status in ('serving', 'waiting')
  ), numbered as (
    select
      id,
      display_name,
      service_name_snapshot,
      status,
      started_at,
      row_number() over (order by position_order, id) as queue_position,
      coalesce(
        sum(remaining_minutes) over (
          order by position_order, id
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::integer as wait_minutes
    from queue_rows
  )
  select
    id,
    display_name,
    service_name_snapshot,
    status,
    queue_position,
    queue_position - 1,
    wait_minutes,
    started_at
  from numbered
  order by queue_position;
$$;

revoke all on function public.get_public_queue() from public;
grant execute on function public.get_public_queue() to anon, authenticated;

commit;
