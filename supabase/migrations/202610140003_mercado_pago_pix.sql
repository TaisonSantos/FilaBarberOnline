-- Mercado Pago Checkout Transparente (Orders API) Pix support.
-- Adds columns and private RPCs to existing tables; does not create tables
-- and does not change any existing RLS policy.

alter table public.payment_transactions
  add column if not exists checkout_request_id uuid,
  add column if not exists checkout_token_hash text,
  add column if not exists checkout_contact_hash text,
  add column if not exists checkout_ip_hash text,
  add column if not exists payer_email text,
  add column if not exists provider_order_id text,
  add column if not exists status_check_window_at timestamptz,
  add column if not exists status_check_count integer not null default 0;

create unique index if not exists payment_transactions_checkout_request_uidx
  on public.payment_transactions (checkout_request_id)
  where checkout_request_id is not null;

create unique index if not exists payment_transactions_provider_order_uidx
  on public.payment_transactions (provider_order_id)
  where provider_order_id is not null;

create index if not exists payment_transactions_checkout_contact_rate_idx
  on public.payment_transactions (checkout_contact_hash, created_at)
  where checkout_contact_hash is not null;

create index if not exists payment_transactions_checkout_ip_rate_idx
  on public.payment_transactions (checkout_ip_hash, created_at)
  where checkout_ip_hash is not null;

create or replace function public.create_online_payment_intent(
  p_request_id uuid,
  p_token_hash text,
  p_name text,
  p_phone text,
  p_service_id uuid,
  p_payer_email text,
  p_contact_hash text,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service public.services%rowtype;
  v_client_id uuid;
  v_queue_entry_id uuid;
  v_transaction_id uuid;
  v_existing record;
  v_rate_key text;
  v_attempt_count integer;
begin
  if p_request_id is null
     or p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_contact_hash is null
     or p_contact_hash !~ '^[0-9a-f]{64}$'
     or (p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$')
     or nullif(btrim(p_name), '') is null
     or length(btrim(p_name)) < 2
     or nullif(btrim(p_phone), '') is null
     or nullif(btrim(p_payer_email), '') is null
     or btrim(p_payer_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or length(btrim(p_name)) > 120
     or length(btrim(p_phone)) > 32
     or btrim(p_phone) !~ '^[0-9]{10,13}$'
     or length(btrim(p_payer_email)) > 254 then
    raise exception 'Dados do checkout inválidos.' using errcode = '22023';
  end if;

  -- Serialize retries for the same client request before inserting anything.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select
    pt.id as transaction_id,
    pt.queue_entry_id,
    pt.provider_order_id,
    pt.status,
    pt.checkout_token_hash,
    pt.payer_email,
    c.name,
    c.phone,
    q.service_id
  into v_existing
  from public.payment_transactions pt
  join public.queue_entries q on q.id = pt.queue_entry_id
  join public.clients c on c.id = q.client_id
  where pt.checkout_request_id = p_request_id
  for update of pt;

  if found then
    if v_existing.checkout_token_hash is distinct from p_token_hash
       or v_existing.payer_email is distinct from lower(btrim(p_payer_email))
       or v_existing.name is distinct from btrim(p_name)
       or v_existing.phone is distinct from btrim(p_phone)
       or v_existing.service_id is distinct from p_service_id then
      raise exception 'Esta solicitação já está vinculada a outros dados.' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'payment_transaction_id', v_existing.transaction_id,
      'queue_entry_id', v_existing.queue_entry_id,
      'provider_order_id', v_existing.provider_order_id,
      'status', v_existing.status
    );
  end if;

  -- Stable DB-backed rate limits. Retries of the same checkout return above
  -- and do not consume another attempt. Locks serialize concurrent requests.
  for v_rate_key in
    select lock_key
    from unnest(array[p_contact_hash, p_ip_hash]) as rate_keys(lock_key)
    where lock_key is not null
    order by lock_key
  loop
    perform pg_advisory_xact_lock(hashtextextended('checkout-rate:' || v_rate_key, 1));
  end loop;

  select count(*) into v_attempt_count
  from public.payment_transactions
  where checkout_contact_hash = p_contact_hash
    and created_at >= now() - interval '1 hour';
  if v_attempt_count >= 5 then
    raise exception 'Muitas tentativas para estes dados. Aguarde uma hora e tente novamente.' using errcode = 'P0001';
  end if;

  if p_ip_hash is not null then
    select count(*) into v_attempt_count
    from public.payment_transactions
    where checkout_ip_hash = p_ip_hash
      and created_at >= now() - interval '1 hour';
    if v_attempt_count >= 10 then
      raise exception 'Limite de tentativas atingido para esta conexão. Aguarde e tente novamente.' using errcode = 'P0001';
    end if;
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
    'online', 'payment_pending', 1000
  ) returning id into v_queue_entry_id;

  insert into public.payment_transactions (
    queue_entry_id, provider, amount_cents, status,
    checkout_request_id, checkout_token_hash, checkout_contact_hash,
    checkout_ip_hash, payer_email
  ) values (
    v_queue_entry_id, 'mercado_pago', 1000, 'pending',
    p_request_id, p_token_hash, p_contact_hash, p_ip_hash,
    lower(btrim(p_payer_email))
  ) returning id into v_transaction_id;

  return jsonb_build_object(
    'payment_transaction_id', v_transaction_id,
    'queue_entry_id', v_queue_entry_id,
    'provider_order_id', null,
    'status', 'pending'
  );
end;
$$;

create or replace function public.record_mercado_pago_order(
  p_transaction_id uuid,
  p_order_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id text;
begin
  if nullif(btrim(p_order_id), '') is null then
    raise exception 'Identificador do pedido inválido.' using errcode = '22023';
  end if;

  update public.payment_transactions
  set provider_order_id = coalesce(provider_order_id, btrim(p_order_id))
  where id = p_transaction_id
    and provider = 'mercado_pago'
    and status in ('pending', 'paid')
    and (provider_order_id is null or provider_order_id = btrim(p_order_id))
  returning provider_order_id into v_order_id;

  if v_order_id is null then
    raise exception 'Não foi possível associar o pedido à transação.' using errcode = 'P0002';
  end if;
  return true;
end;
$$;

create or replace function public.get_online_payment_status(
  p_request_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_transaction_id uuid;
  v_status text;
  v_provider_order_id text;
  v_created_at timestamptz;
  v_paid_at timestamptz;
  v_queue_status text;
  v_queue_entry_id uuid;
  v_window_at timestamptz;
  v_check_count integer;
begin
  select pt.id, pt.status, pt.provider_order_id, pt.created_at, pt.paid_at,
         pt.status_check_window_at, pt.status_check_count, pt.queue_entry_id
    into v_transaction_id, v_status, v_provider_order_id, v_created_at, v_paid_at,
         v_window_at, v_check_count, v_queue_entry_id
  from public.payment_transactions pt
  where pt.checkout_request_id = p_request_id
    and pt.checkout_token_hash = p_token_hash
  for update;

  if v_transaction_id is null then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0002';
  end if;

  if v_window_at is null or now() - v_window_at >= interval '1 minute' then
    update public.payment_transactions
    set status_check_window_at = now(), status_check_count = 1
    where id = v_transaction_id;
  elsif v_check_count >= 20 then
    return jsonb_build_object('rate_limited', true);
  else
    update public.payment_transactions
    set status_check_count = status_check_count + 1
    where id = v_transaction_id;
  end if;

  select status into v_queue_status from public.queue_entries where id = v_queue_entry_id;
  v_result := jsonb_build_object(
    'status', v_status,
    'provider_order_id', v_provider_order_id,
    'queue_status', v_queue_status,
    'created_at', v_created_at,
    'paid_at', v_paid_at
  );
  return v_result;
end;
$$;

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
  v_released boolean := false;
  v_rows integer := 0;
  v_changed boolean := false;
begin
  if p_external_reference is distinct from p_transaction_id::text
     or p_total_amount_cents is distinct from 1000
     or p_currency_id is distinct from 'BRL'
     or p_payment_method_id is distinct from 'pix' then
    raise exception 'Os dados do pedido não correspondem a esta cobrança.' using errcode = '22023';
  end if;

  select * into v_tx
  from public.payment_transactions
  where id = p_transaction_id and provider = 'mercado_pago'
  for update;
  if not found then
    raise exception 'Transação não encontrada.' using errcode = 'P0002';
  end if;
  if v_tx.provider_order_id is not null and v_tx.provider_order_id <> p_order_id then
    raise exception 'O pedido já está associado a outra cobrança.' using errcode = '22023';
  end if;

  update public.payment_transactions
  set provider_order_id = coalesce(provider_order_id, p_order_id)
  where id = p_transaction_id;

  select status into v_queue_status
  from public.queue_entries where id = v_tx.queue_entry_id for update;
  if not found then
    raise exception 'Entrada da fila não encontrada.' using errcode = 'P0002';
  end if;

  if p_order_status = 'processed'
     and p_order_status_detail = 'accredited'
     and p_payment_status = 'processed'
     and p_payment_status_detail = 'accredited'
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
      v_changed := v_rows = 1;
    end if;

    if v_queue_status = 'payment_pending' then
      update public.queue_entries
      set status = 'waiting'
      where id = v_tx.queue_entry_id and status = 'payment_pending';
      v_released := found;
    elsif v_queue_status in ('waiting', 'serving', 'completed') then
      v_released := true;
    elsif v_tx.status <> 'paid' then
      raise exception 'A entrada não está mais pendente de pagamento.' using errcode = '55000';
    end if;
  elsif p_order_status in ('failed', 'canceled', 'expired') then
    if v_tx.status = 'pending' then
      update public.payment_transactions set status = 'failed'
      where id = p_transaction_id and status = 'pending';
      update public.queue_entries
      set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
      where id = v_tx.queue_entry_id and status = 'payment_pending';
      v_changed := true;
    end if;
  elsif p_order_status = 'refunded' and v_tx.status = 'paid' then
    update public.payment_transactions set status = 'refunded'
    where id = p_transaction_id and status = 'paid';
    update public.queue_entries
    set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now())
    where id = v_tx.queue_entry_id and status = 'waiting';
    v_changed := true;
  end if;

  if v_changed or v_released then
    perform public.broadcast_public_queue_update();
  end if;

  return jsonb_build_object(
    'payment_status', case when p_order_status = 'processed' and v_released then 'paid' else v_tx.status end,
    'queue_status', (select status from public.queue_entries where id = v_tx.queue_entry_id),
    'released', v_released
  );
end;
$$;

revoke all on function public.create_online_payment_intent(uuid, text, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.record_mercado_pago_order(uuid, text) from public, anon, authenticated;
revoke all on function public.get_online_payment_status(uuid, text) from public, anon, authenticated;
revoke all on function public.apply_mercado_pago_order_update(uuid, text, text, text, text, text, text, integer, integer, text, text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.create_online_payment_intent(uuid, text, text, text, uuid, text, text, text) to service_role;
grant execute on function public.record_mercado_pago_order(uuid, text) to service_role;
grant execute on function public.get_online_payment_status(uuid, text) to service_role;
grant execute on function public.apply_mercado_pago_order_update(uuid, text, text, text, text, text, text, integer, integer, text, text, text, integer, integer) to service_role;
