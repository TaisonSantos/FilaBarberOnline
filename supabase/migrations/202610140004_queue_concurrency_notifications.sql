-- Serializes visible queue mutations without taking a table-wide lock.
-- Apply only after reviewing the assumed base schema and the already-applied
-- migrations 202610140001-003. Existing RLS policies are not changed.
begin;

-- Nullable state fields preserve all existing notification history. New queue
-- snapshots use them to suppress only unchanged in-app state notifications.
alter table public.notifications
  add column if not exists event_type text,
  add column if not exists queue_position bigint,
  add column if not exists people_ahead bigint,
  add column if not exists estimated_wait_minutes integer;

create index if not exists notifications_queue_state_lookup_idx
  on public.notifications (queue_entry_id, channel, created_at desc, id desc);

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

  -- Every visible queue mutation takes this transaction lock before touching
  -- queue rows. The shared key serializes RPCs without blocking unrelated SQL.
  perform pg_advisory_xact_lock(413528, 1);

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
    client_id, service_id, service_name_snapshot,
    service_duration_minutes_snapshot, service_price_cents_snapshot,
    entry_type, status, deposit_cents
  ) values (
    v_client_id, v_service.id, v_service.name,
    v_service.duration_minutes, v_service.price_cents,
    'in_person', 'waiting', 0
  ) returning id into v_queue_entry_id;

  perform public.broadcast_public_queue_update();
  return v_queue_entry_id;
end;
$$;

revoke all on function public.admin_add_walkin(text, text, uuid) from public, anon, service_role;
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

  perform pg_advisory_xact_lock(413528, 1);

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

revoke all on function public.admin_remove_queue_entry(uuid) from public, anon, service_role;
grant execute on function public.admin_remove_queue_entry(uuid) to authenticated;

create or replace function public.admin_start_next_service()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_queue_entry_id uuid;
  v_started_at timestamptz := clock_timestamp();
  v_rows integer;
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(413528, 1);

  if exists (select 1 from public.queue_entries q where q.status = 'serving') then
    raise exception 'Já existe um atendimento em andamento. Finalize o corte atual antes de iniciar outro.'
      using errcode = '55000';
  end if;

  select q.id into v_queue_entry_id
  from public.queue_entries q
  where q.status = 'waiting'
  order by q.position_order, q.id
  limit 1
  for update;

  if v_queue_entry_id is null then
    raise exception 'Não há clientes aguardando na fila.' using errcode = 'P0002';
  end if;

  update public.queue_entries q
  set status = 'serving', started_at = v_started_at
  where q.id = v_queue_entry_id and q.status = 'waiting';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'A fila mudou antes de iniciar o atendimento. Atualize e tente novamente.'
      using errcode = '40001';
  end if;

  perform public.broadcast_public_queue_update();
  return jsonb_build_object('queue_entry_id', v_queue_entry_id, 'started_at', v_started_at);
end;
$$;

revoke all on function public.admin_start_next_service() from public, anon, service_role;
grant execute on function public.admin_start_next_service() to authenticated;

-- The expected ID makes retries/double clicks idempotent with respect to the
-- client the barber confirmed, even if the next client has already been called.
create function public.admin_finish_current_service(p_expected_queue_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_current_id uuid;
  v_next_id uuid;
  v_serving_count integer;
  v_notification_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(413528, 1);

  select count(*) into v_serving_count
  from public.queue_entries q where q.status = 'serving';
  if v_serving_count > 1 then
    raise exception 'A fila contém mais de um atendimento em andamento. Corrija o estado antes de finalizar.'
      using errcode = '55000';
  end if;

  select q.id into v_current_id
  from public.queue_entries q
  where q.status = 'serving'
  order by q.started_at nulls first, q.position_order, q.id
  limit 1
  for update;

  if v_current_id is null then
    raise exception 'Não há atendimento em andamento para finalizar.' using errcode = 'P0002';
  end if;
  if p_expected_queue_entry_id is null or p_expected_queue_entry_id is distinct from v_current_id then
    raise exception 'A fila mudou enquanto a finalização aguardava. Atualize o painel e tente novamente.'
      using errcode = '40001';
  end if;

  update public.queue_entries
  set status = 'completed', completed_at = v_now
  where id = v_current_id and status = 'serving';

  select q.id into v_next_id
  from public.queue_entries q
  where q.status = 'waiting'
  order by q.position_order, q.id
  limit 1
  for update;

  if v_next_id is not null then
    update public.queue_entries
    set status = 'serving', started_at = v_now
    where id = v_next_id and status = 'waiting';
  end if;

  -- Store the state sent to each client. Old notifications have NULL state
  -- fields and remain untouched; the first post-migration update refreshes them.
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
      row_number() over (order by position_order, id)::bigint as queue_position,
      coalesce(
        sum(remaining_minutes) over (
          order by position_order, id
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::integer as wait_minutes
    from queue_rows
  ), changed_queue as (
    select
      oq.*,
      case when oq.status = 'serving' then 'turn' else 'position_update' end as new_event_type
    from ordered_queue oq
    left join lateral (
      select n.event_type, n.queue_position, n.people_ahead, n.estimated_wait_minutes
      from public.notifications n
      where n.queue_entry_id = oq.id and n.channel = 'in_app'
      order by n.created_at desc, n.id desc
      limit 1
    ) previous on true
    where previous.event_type is distinct from case when oq.status = 'serving' then 'turn' else 'position_update' end
       or previous.queue_position is distinct from oq.queue_position
       or previous.people_ahead is distinct from oq.queue_position - 1
       or previous.estimated_wait_minutes is distinct from oq.wait_minutes
  )
  insert into public.notifications (
    queue_entry_id, channel, message, status,
    event_type, queue_position, people_ahead, estimated_wait_minutes
  )
  select
    id,
    'in_app',
    case when status = 'serving' then
      format(
        'É sua vez! Você está na posição #%s, com %s %s na frente. Dirija-se à barbearia.',
        queue_position,
        queue_position - 1,
        case when queue_position = 2 then 'pessoa' else 'pessoas' end
      )
    else
      format(
        'Você está na posição #%s, com %s %s na frente. Espera aproximada: ~ %s min.',
        queue_position,
        queue_position - 1,
        case when queue_position = 2 then 'pessoa' else 'pessoas' end,
        wait_minutes
      )
    end,
    'pending', new_event_type, queue_position, queue_position - 1, wait_minutes
  from changed_queue;
  get diagnostics v_notification_count = row_count;

  perform public.broadcast_public_queue_update();

  return jsonb_build_object(
    'completed_queue_entry_id', v_current_id,
    'next_queue_entry_id', v_next_id,
    'notifications_created', v_notification_count
  );
end;
$$;

revoke all on function public.admin_finish_current_service(uuid) from public, anon, service_role;
grant execute on function public.admin_finish_current_service(uuid) to authenticated;

-- Keep the original no-argument RPC contract available to already-open app
-- versions. It snapshots the current ID before delegating, so simultaneous
-- calls still compete on the same expected client and only one can succeed.
create or replace function public.admin_finish_current_service()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_expected_queue_entry_id uuid;
begin
  if not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.' using errcode = '42501';
  end if;

  -- Acquire the common lock before reading the current row. The delegated
  -- UUID overload acquires this same transaction lock again; PostgreSQL lets
  -- its current owner reacquire it, so this does not wait on another caller.
  perform pg_advisory_xact_lock(413528, 1);

  select q.id into v_expected_queue_entry_id
  from public.queue_entries q
  where q.status = 'serving'
  order by q.started_at nulls first, q.position_order, q.id
  limit 1;
  if v_expected_queue_entry_id is null then
    raise exception 'Não há atendimento em andamento para finalizar.' using errcode = 'P0002';
  end if;

  return public.admin_finish_current_service(v_expected_queue_entry_id);
end;
$$;

revoke all on function public.admin_finish_current_service() from public, anon, service_role;
grant execute on function public.admin_finish_current_service() to authenticated;

-- Pix callbacks use the same queue lock before locking payment/queue rows, so
-- a payment release cannot interleave with start, finish, add, or removal.
create or replace function public.apply_mercado_pago_order_update(
  p_transaction_id uuid,
  p_order_id text,
  p_payment_id text,
  p_external_reference text,
  p_order_status text,
  p_order_status_detail text,
  p_currency_id text,
  p_total_amount_cents integer,
  p_total_paid_cents integer,
  p_payment_method_id text,
  p_payment_status text,
  p_payment_status_detail text,
  p_payment_amount_cents integer,
  p_paid_amount_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx public.payment_transactions%rowtype;
  v_queue_status text;
  v_queue_entry_type text;
  v_queue_deposit_cents integer;
  v_persisted_payment_status text;
  v_persisted_queue_status text;
  v_released boolean := false;
  v_rows integer := 0;
  v_changed boolean := false;
  v_public_queue_changed boolean := false;
begin
  if p_transaction_id is null
     or nullif(btrim(p_order_id), '') is null
     or nullif(btrim(p_payment_id), '') is null
     or p_external_reference is distinct from p_transaction_id::text
     or p_total_amount_cents is distinct from 1000
     or p_currency_id is distinct from 'BRL'
     or p_payment_method_id is distinct from 'pix' then
    raise exception 'Os dados do pedido não correspondem a esta cobrança.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(413528, 1);

  select * into v_tx
  from public.payment_transactions
  where id = p_transaction_id and provider = 'mercado_pago'
  for update;
  if not found then
    raise exception 'Transação não encontrada.' using errcode = 'P0002';
  end if;
  if v_tx.amount_cents is distinct from 1000 then
    raise exception 'O valor registrado para a transação não corresponde ao sinal de R$ 10,00.' using errcode = '22023';
  end if;
  if v_tx.provider_order_id is not null and v_tx.provider_order_id <> p_order_id then
    raise exception 'O pedido já está associado a outra cobrança.' using errcode = '22023';
  end if;
  if v_tx.provider_payment_id is not null and v_tx.provider_payment_id <> p_payment_id then
    raise exception 'O pagamento já está associado a outra transação do pedido.' using errcode = '22023';
  end if;

  if v_tx.provider_order_id is null then
    update public.payment_transactions
    set provider_order_id = p_order_id
    where id = p_transaction_id and provider_order_id is null;
    get diagnostics v_rows = row_count;
    v_changed := v_changed or v_rows = 1;
  end if;

  select status, entry_type, deposit_cents
    into v_queue_status, v_queue_entry_type, v_queue_deposit_cents
  from public.queue_entries where id = v_tx.queue_entry_id for update;
  if not found then
    raise exception 'Entrada da fila não encontrada.' using errcode = 'P0002';
  end if;
  if v_queue_entry_type is distinct from 'online'
     or v_queue_deposit_cents is distinct from 1000 then
    raise exception 'A entrada da fila não corresponde a um sinal online de R$ 10,00.' using errcode = '22023';
  end if;

  if p_order_status = 'processed'
     and p_order_status_detail = 'accredited'
     and p_payment_status = 'processed'
     and p_payment_status_detail = 'accredited'
     and p_total_paid_cents = 1000
     and p_payment_amount_cents = 1000
     and p_paid_amount_cents = 1000 then
    if v_tx.status not in ('pending', 'paid') then
      raise exception 'A transação não está pendente de confirmação.' using errcode = '55000';
    end if;
    if v_tx.status <> 'paid' then
      update public.payment_transactions
      set status = 'paid', provider_payment_id = p_payment_id, paid_at = coalesce(paid_at, now())
      where id = p_transaction_id and status = 'pending';
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows = 1;
    end if;

    if v_queue_status = 'payment_pending' then
      update public.queue_entries
      set status = 'waiting'
      where id = v_tx.queue_entry_id and status = 'payment_pending';
      v_released := found;
      v_changed := v_changed or v_released;
      v_public_queue_changed := v_public_queue_changed or v_released;
    elsif v_queue_status in ('waiting', 'serving', 'completed') then
      v_released := true;
    elsif v_tx.status <> 'paid' then
      raise exception 'A entrada não está mais pendente de pagamento.' using errcode = '55000';
    end if;
  elsif p_order_status in ('failed', 'canceled', 'expired') then
    if v_tx.status = 'pending' then
      update public.payment_transactions set status = 'failed'
      where id = p_transaction_id and status = 'pending';
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows = 1;
      update public.queue_entries
      set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
      where id = v_tx.queue_entry_id and status = 'payment_pending';
      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows = 1;
      v_public_queue_changed := v_public_queue_changed or v_rows = 1;
    end if;
  elsif p_order_status = 'refunded' and v_tx.status = 'paid' then
    update public.payment_transactions set status = 'refunded'
    where id = p_transaction_id and status = 'paid';
    get diagnostics v_rows = row_count;
    v_changed := v_changed or v_rows = 1;
    update public.queue_entries
    set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
    where id = v_tx.queue_entry_id and status = 'waiting';
    get diagnostics v_rows = row_count;
    v_changed := v_changed or v_rows = 1;
    v_public_queue_changed := v_public_queue_changed or v_rows = 1;
  end if;

  if v_changed and v_public_queue_changed then
    perform public.broadcast_public_queue_update();
  end if;

  select pt.status, q.status
    into v_persisted_payment_status, v_persisted_queue_status
  from public.payment_transactions pt
  join public.queue_entries q on q.id = pt.queue_entry_id
  where pt.id = p_transaction_id;

  return jsonb_build_object(
    'payment_status', v_persisted_payment_status,
    'queue_status', v_persisted_queue_status,
    'released', v_released
  );
end;
$$;

revoke all on function public.apply_mercado_pago_order_update(uuid, text, text, text, text, text, text, integer, integer, text, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.apply_mercado_pago_order_update(uuid, text, text, text, text, text, text, integer, integer, text, text, text, integer, integer) to service_role;

commit;
