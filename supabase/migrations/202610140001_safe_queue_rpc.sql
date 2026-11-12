-- Safe integration helpers for the existing schema.
-- This migration does not create tables or change existing RLS policies.

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
      c.name,
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
      name,
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
    name,
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

create or replace function public.broadcast_public_queue_update()
returns void
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  v_queue jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(q) order by q."position"), '[]'::jsonb)
    into v_queue
  from public.get_public_queue() q;

  perform realtime.send(
    jsonb_build_object('queue', v_queue),
    'queue_updated',
    'public_queue',
    false
  );
exception when others then
  -- The RPC still succeeds if Realtime is temporarily unavailable;
  -- the client can refresh the safe public snapshot on its fallback timer.
  raise warning 'Queue broadcast was not delivered: %', sqlerrm;
end;
$$;

revoke all on function public.broadcast_public_queue_update() from public, anon, authenticated;

create or replace function public.admin_add_walkin(
  p_name text,
  p_phone text,
  p_service_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_client_id uuid;
  v_queue_entry_id uuid;
  v_service public.services%rowtype;
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  if nullif(btrim(p_name), '') is null or nullif(btrim(p_phone), '') is null then
    raise exception 'Nome e telefone são obrigatórios.' using errcode = '22023';
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and active = true
  for share;
  if not found then
    raise exception 'Serviço ativo não encontrado.' using errcode = '22023';
  end if;

  insert into public.clients (name, phone)
  values (btrim(p_name), btrim(p_phone))
  returning id into v_client_id;

  insert into public.queue_entries (
    client_id,
    service_id,
    service_name_snapshot,
    service_duration_minutes_snapshot,
    service_price_cents_snapshot,
    entry_type,
    status,
    deposit_cents
  ) values (
    v_client_id,
    v_service.id,
    v_service.name,
    v_service.duration_minutes,
    v_service.price_cents,
    'in_person',
    'waiting',
    0
  )
  returning id into v_queue_entry_id;

  perform public.broadcast_public_queue_update();
  return v_queue_entry_id;
end;
$$;

revoke all on function public.admin_add_walkin(text, text, uuid) from public, anon;
grant execute on function public.admin_add_walkin(text, text, uuid) to authenticated;

create or replace function public.admin_remove_queue_entry(p_queue_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_rows integer;
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  update public.queue_entries
  set status = 'cancelled', cancelled_at = now()
  where id = p_queue_entry_id and status = 'waiting';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Cliente não encontrado na fila de espera.' using errcode = 'P0002';
  end if;

  perform public.broadcast_public_queue_update();
  return true;
end;
$$;

revoke all on function public.admin_remove_queue_entry(uuid) from public, anon;
grant execute on function public.admin_remove_queue_entry(uuid) to authenticated;

create or replace function public.admin_finish_current_service()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_current_id uuid;
  v_next_id uuid;
  v_notification_count integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  select id into v_current_id
  from public.queue_entries
  where status = 'serving'
  order by started_at nulls first, position_order, id
  for update skip locked
  limit 1;

  if v_current_id is null then
    raise exception 'Não há atendimento em andamento para finalizar.' using errcode = 'P0002';
  end if;

  update public.queue_entries
  set status = 'completed', completed_at = v_now
  where id = v_current_id;

  select id into v_next_id
  from public.queue_entries
  where status = 'waiting'
  order by position_order, id
  for update skip locked
  limit 1;

  if v_next_id is not null then
    update public.queue_entries
    set status = 'serving', started_at = v_now
    where id = v_next_id;
  end if;

  with queue_rows as (
    select
      q.id,
      q.status,
      q.position_order,
      q.started_at,
      case
        when q.status = 'serving' and q.started_at is not null then
          greatest(
            q.service_duration_minutes_snapshot
              - floor(extract(epoch from (v_now - q.started_at)) / 60)::integer,
            0
          )
        else q.service_duration_minutes_snapshot
      end as remaining_minutes
    from public.queue_entries q
    where q.status in ('serving', 'waiting')
  ), ordered_queue as (
    select
      id,
      status,
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
  insert into public.notifications (queue_entry_id, channel, message, status)
  select
    id,
    'in_app',
    case when status = 'serving' then
      'É sua vez! Você está na posição #1, com 0 pessoas na frente. Dirija-se à barbearia.'
    else
      format(
        'Você está na posição #%s, com %s %s na frente. Espera aproximada: ~ %s min.',
        queue_position,
        queue_position - 1,
        case when queue_position = 2 then 'pessoa' else 'pessoas' end,
        wait_minutes
      )
    end,
    'pending'
  from ordered_queue;
  get diagnostics v_notification_count = row_count;

  perform public.broadcast_public_queue_update();

  return jsonb_build_object(
    'completed_queue_entry_id', v_current_id,
    'next_queue_entry_id', v_next_id,
    'notifications_created', v_notification_count
  );
end;
$$;

revoke all on function public.admin_finish_current_service() from public, anon;
grant execute on function public.admin_finish_current_service() to authenticated;
