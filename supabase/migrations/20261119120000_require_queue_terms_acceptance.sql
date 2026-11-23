begin;

alter table public.payment_transactions
  add column if not exists online_queue_terms_version text,
  add column if not exists online_queue_terms_accepted_at timestamptz;

create or replace function public.record_online_queue_terms_acceptance(
  p_transaction_id uuid,
  p_terms_version text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_transaction_id is null
     or p_terms_version is distinct from 'queue-presence-v1-2026-11-19' then
    raise exception 'O aceite do termo de entrada online não foi confirmado.'
      using errcode = '22023';
  end if;

  update public.payment_transactions
  set online_queue_terms_version = p_terms_version,
      online_queue_terms_accepted_at = now()
  where id = p_transaction_id
    and checkout_request_id is not null;

  return found;
end;
$$;

revoke all on function public.record_online_queue_terms_acceptance(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_online_queue_terms_acceptance(uuid, text)
  to service_role;

create or replace function public.create_online_payment_intent_with_terms(
  p_request_id uuid,
  p_token_hash text,
  p_name text,
  p_phone text,
  p_service_id uuid,
  p_payer_email text,
  p_contact_hash text,
  p_ip_hash text,
  p_terms_version text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_intent jsonb;
  v_terms_recorded boolean;
begin
  if p_terms_version is distinct from 'queue-presence-v1-2026-11-19' then
    raise exception 'Leia e aceite o termo de responsabilidade antes de gerar o Pix.'
      using errcode = '22023';
  end if;

  v_intent := public.create_online_payment_intent(
    p_request_id,
    p_token_hash,
    p_name,
    p_phone,
    p_service_id,
    p_payer_email,
    p_contact_hash,
    p_ip_hash
  );

  v_terms_recorded := public.record_online_queue_terms_acceptance(
    (v_intent->>'payment_transaction_id')::uuid,
    p_terms_version
  );

  if not coalesce(v_terms_recorded, false) then
    raise exception 'Não foi possível registrar o aceite do termo.'
      using errcode = '55000';
  end if;

  return v_intent;
end;
$$;

revoke all on function public.create_online_payment_intent_with_terms(
  uuid, text, text, text, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_online_payment_intent_with_terms(
  uuid, text, text, text, uuid, text, text, text, text
) to service_role;

commit;
