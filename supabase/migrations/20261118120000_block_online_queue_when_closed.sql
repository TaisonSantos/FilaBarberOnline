begin;

-- Reject new online payment intents outside the business hours configured by
-- the owner. Use the barbershop's local timezone rather than the database UTC.
do $$
declare
  v_definition text;
  v_marker text := '  -- Stable DB-backed rate limits.';
  v_guard text := $guard$  if not exists (
    select 1
    from public.business_hours h
    where h.day_of_week = extract(dow from timezone('America/Sao_Paulo', now()))::smallint
      and h.is_open
      and timezone('America/Sao_Paulo', now())::time >= h.opens_at
      and timezone('America/Sao_Paulo', now())::time < h.closes_at
  ) then
    raise exception 'A barbearia está fechada no momento. Tente novamente durante o horário de funcionamento.'
      using errcode = '55000';
  end if;

$guard$;
begin
  select pg_get_functiondef(
    'public.create_online_payment_intent(uuid,text,text,text,uuid,text,text,text)'::regprocedure
  ) into v_definition;

  if position(v_marker in v_definition) = 0 then
    raise exception 'Não foi possível localizar o ponto de validação do horário de funcionamento.';
  end if;

  v_definition := replace(v_definition, v_marker, v_guard || v_marker);

  if position('public.business_hours' in v_definition) = 0
     or position('America/Sao_Paulo' in v_definition) = 0
     or position('using errcode = ''55000''' in v_definition) = 0 then
    raise exception 'Não foi possível preparar o bloqueio da fila fora do horário.';
  end if;

  execute v_definition;
end;
$$;

commit;
