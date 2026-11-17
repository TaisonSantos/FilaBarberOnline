begin;

create table if not exists public.online_payment_settings (
  singleton boolean primary key default true check (singleton),
  entry_fee_cents integer not null default 100
    check (entry_fee_cents between 1 and 2000000),
  updated_at timestamptz not null default now()
);

insert into public.online_payment_settings (singleton, entry_fee_cents)
values (true, 100)
on conflict (singleton) do nothing;

alter table public.online_payment_settings enable row level security;

create or replace function public.get_public_online_entry_fee()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select entry_fee_cents
  from public.online_payment_settings
  where singleton = true;
$$;

revoke all on function public.get_public_online_entry_fee() from public;
grant execute on function public.get_public_online_entry_fee() to anon, authenticated;

create or replace function public.admin_save_online_entry_fee(p_entry_fee_cents integer)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_entry_fee_cents integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso restrito ao proprietário.' using errcode = '42501';
  end if;

  if p_entry_fee_cents is null or p_entry_fee_cents not between 1 and 2000000 then
    raise exception 'O valor da entrada deve ficar entre R$ 0,01 e R$ 20.000,00.' using errcode = '22023';
  end if;

  update public.online_payment_settings
  set entry_fee_cents = p_entry_fee_cents, updated_at = now()
  where singleton = true
  returning entry_fee_cents into v_entry_fee_cents;

  return v_entry_fee_cents;
end;
$$;

revoke all on function public.admin_save_online_entry_fee(integer) from public, anon;
grant execute on function public.admin_save_online_entry_fee(integer) to authenticated;

-- Preserve the existing checkout protections while snapshotting the current fee.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.create_online_payment_intent(uuid,text,text,text,uuid,text,text,text)'::regprocedure
  ) into v_definition;

  v_definition := replace(v_definition,
    '  v_attempt_count integer;',
    '  v_attempt_count integer;' || E'\n' || '  v_entry_fee_cents integer;');
  v_definition := replace(v_definition,
    '    pt.status,' || E'\n' || '    pt.checkout_token_hash,',
    '    pt.status,' || E'\n' || '    pt.amount_cents,' || E'\n' || '    pt.checkout_token_hash,');
  v_definition := replace(v_definition,
    '      ''status'', v_existing.status' || E'\n' || '    );',
    '      ''status'', v_existing.status,' || E'\n' || '      ''amount_cents'', v_existing.amount_cents' || E'\n' || '    );');
  v_definition := replace(v_definition,
    '  insert into public.clients (name, phone)',
    '  select entry_fee_cents into v_entry_fee_cents' || E'\n' ||
    '  from public.online_payment_settings where singleton = true;' || E'\n' || E'\n' ||
    '  if v_entry_fee_cents is null or v_entry_fee_cents < 1 then' || E'\n' ||
    '    raise exception ''O valor da entrada online não está configurado.'' using errcode = ''55000'';' || E'\n' ||
    '  end if;' || E'\n' || E'\n' ||
    '  insert into public.clients (name, phone)');
  v_definition := replace(v_definition,
    '''online'', ''payment_pending'', 1000',
    '''online'', ''payment_pending'', v_entry_fee_cents');
  v_definition := replace(v_definition,
    'v_queue_entry_id, ''mercado_pago'', 1000, ''pending'',',
    'v_queue_entry_id, ''mercado_pago'', v_entry_fee_cents, ''pending'',');
  v_definition := replace(v_definition,
    '    ''status'', ''pending''' || E'\n' || '  );',
    '    ''status'', ''pending'',' || E'\n' || '    ''amount_cents'', v_entry_fee_cents' || E'\n' || '  );');

  if position('v_entry_fee_cents' in v_definition) = 0
     or position('''amount_cents'', v_existing.amount_cents' in v_definition) = 0
     or position('''amount_cents'', v_entry_fee_cents' in v_definition) = 0 then
    raise exception 'Não foi possível preparar a função de criação de pagamento para o valor configurável.';
  end if;
  execute v_definition;
end;
$$;

-- Confirm orders against the amount captured by that checkout, so later setting
-- changes do not change the amount expected for already-created Pix orders.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.apply_mercado_pago_order_update(uuid,text,text,text,text,text,text,integer,integer,text,text,text,integer,integer)'::regprocedure
  ) into v_definition;

  v_definition := replace(v_definition,
    '     or p_total_amount_cents is distinct from 1000' || E'\n',
    '');
  v_definition := replace(v_definition,
    '  if v_tx.amount_cents is distinct from 1000 then' || E'\n' ||
    '    raise exception ''O valor registrado para a transação não corresponde ao sinal de R$ 10,00.'' using errcode = ''22023'';' || E'\n' ||
    '  end if;',
    '  if v_tx.amount_cents is null or v_tx.amount_cents < 1' || E'\n' ||
    '     or p_total_amount_cents is distinct from v_tx.amount_cents then' || E'\n' ||
    '    raise exception ''O valor do pedido não corresponde ao valor registrado para a transação.'' using errcode = ''22023'';' || E'\n' ||
    '  end if;');
  v_definition := replace(v_definition,
    'v_queue_deposit_cents is distinct from 1000',
    'v_queue_deposit_cents is distinct from v_tx.amount_cents');
  v_definition := replace(v_definition,
    'raise exception ''A entrada da fila não corresponde a um sinal online de R$ 10,00.'' using errcode = ''22023'';',
    'raise exception ''A entrada da fila não corresponde ao valor registrado para a transação.'' using errcode = ''22023'';');
  v_definition := replace(v_definition,
    'p_total_paid_cents = 1000',
    'p_total_paid_cents = v_tx.amount_cents');
  v_definition := replace(v_definition,
    'p_payment_amount_cents = 1000',
    'p_payment_amount_cents = v_tx.amount_cents');
  v_definition := replace(v_definition,
    'p_paid_amount_cents = 1000',
    'p_paid_amount_cents = v_tx.amount_cents');

  if position('p_total_amount_cents is distinct from v_tx.amount_cents' in v_definition) = 0
     or position('p_total_paid_cents = v_tx.amount_cents' in v_definition) = 0
     or position('p_payment_amount_cents = v_tx.amount_cents' in v_definition) = 0
     or position('p_paid_amount_cents = v_tx.amount_cents' in v_definition) = 0
     or position('v_queue_deposit_cents is distinct from v_tx.amount_cents' in v_definition) = 0 then
    raise exception 'Não foi possível preparar a confirmação do Mercado Pago para valores configuráveis.';
  end if;
  execute v_definition;
end;
$$;

-- A valid checkout token is required by the Edge Function before this ID is
-- returned; the ID is used only to highlight that customer's public queue row.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.get_online_payment_status(uuid,text)'::regprocedure
  ) into v_definition;
  v_definition := replace(v_definition,
    '''queue_status'', v_queue_status,' || E'\n' || '    ''created_at'', v_created_at,',
    '''queue_status'', v_queue_status,' || E'\n' ||
    '    ''queue_entry_id'', v_queue_entry_id,' || E'\n' ||
    '    ''created_at'', v_created_at,');
  if position('''queue_entry_id'', v_queue_entry_id' in v_definition) = 0 then
    raise exception 'Não foi possível incluir a entrada autenticada na resposta de status.';
  end if;
  execute v_definition;
end;
$$;

commit;
