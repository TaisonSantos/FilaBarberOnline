begin;

create table if not exists public.business_hours (
  day_of_week smallint primary key check (day_of_week between 0 and 6),
  is_open boolean not null default false,
  opens_at time,
  closes_at time,
  updated_at timestamptz not null default now(),
  check (
    (is_open and opens_at is not null and closes_at is not null and opens_at < closes_at)
    or (not is_open and opens_at is null and closes_at is null)
  )
);

alter table public.business_hours enable row level security;

insert into public.business_hours (day_of_week, is_open, opens_at, closes_at)
values
  (0, true,  '08:00', '13:00'),
  (1, false, null,    null),
  (2, true,  '08:00', '20:00'),
  (3, true,  '08:00', '20:00'),
  (4, true,  '08:00', '20:00'),
  (5, true,  '08:00', '20:00'),
  (6, true,  '08:00', '20:00')
on conflict (day_of_week) do nothing;

create or replace function public.get_public_business_hours()
returns table (day_of_week smallint, is_open boolean, opens_at text, closes_at text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select h.day_of_week, h.is_open,
         case when h.is_open then to_char(h.opens_at, 'HH24:MI') else null end,
         case when h.is_open then to_char(h.closes_at, 'HH24:MI') else null end
  from public.business_hours h
  order by h.day_of_week;
$$;

revoke all on function public.get_public_business_hours() from public;
grant execute on function public.get_public_business_hours() to anon, authenticated;

create or replace function public.admin_get_controls()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso restrito ao proprietário.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day_of_week', h.day_of_week,
        'is_open', h.is_open,
        'opens_at', case when h.is_open then to_char(h.opens_at, 'HH24:MI') else null end,
        'closes_at', case when h.is_open then to_char(h.closes_at, 'HH24:MI') else null end
      ) order by h.day_of_week)
      from public.business_hours h
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'duration_minutes', s.duration_minutes,
        'price_cents', s.price_cents,
        'active', s.active
      ) order by s.name)
      from public.services s
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_get_controls() from public, anon;
grant execute on function public.admin_get_controls() to authenticated;

create or replace function public.admin_save_controls(p_hours jsonb, p_services jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_saved_services integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso restrito ao proprietário.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_hours) is distinct from 'array' or jsonb_array_length(p_hours) <> 7 then
    raise exception 'Informe os horários dos sete dias da semana.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_hours) as h(day_of_week integer, is_open boolean, opens_at text, closes_at text)
    where day_of_week not between 0 and 6
       or is_open is null
       or (is_open and (
         opens_at is null or closes_at is null
         or opens_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or closes_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or opens_at >= closes_at
       ))
       or (not is_open and (opens_at is not null or closes_at is not null))
  ) or (select count(distinct (element.value->>'day_of_week')) from jsonb_array_elements(p_hours) as element(value)) <> 7 then
    raise exception 'Revise os dias e horários informados.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_services) <> 'array' then
    raise exception 'A lista de serviços está inválida.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_services) as s(id uuid, name text, duration_minutes integer, price_cents integer, active boolean)
    where id is null or nullif(btrim(name), '') is null or length(name) > 80
       or duration_minutes is null or duration_minutes not between 5 and 240
       or price_cents is null or price_cents < 0 or price_cents > 2000000
       or active is null
  ) then
    raise exception 'Revise o nome, duração, preço e disponibilidade dos serviços.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_services) as s(id uuid, name text, duration_minutes integer, price_cents integer, active boolean)
    where not exists (select 1 from public.services existing where existing.id = s.id)
  ) then
    raise exception 'Um dos serviços não existe mais. Atualize a tela e tente novamente.' using errcode = '22023';
  end if;

  insert into public.business_hours (day_of_week, is_open, opens_at, closes_at, updated_at)
  select day_of_week::smallint, is_open,
         case when is_open then opens_at::time else null end,
         case when is_open then closes_at::time else null end,
         now()
  from jsonb_to_recordset(p_hours) as h(day_of_week integer, is_open boolean, opens_at text, closes_at text)
  on conflict (day_of_week) do update set
    is_open = excluded.is_open,
    opens_at = excluded.opens_at,
    closes_at = excluded.closes_at,
    updated_at = now();

  update public.services s set
    name = btrim(input.name),
    duration_minutes = input.duration_minutes,
    price_cents = input.price_cents,
    active = input.active
  from jsonb_to_recordset(p_services) as input(id uuid, name text, duration_minutes integer, price_cents integer, active boolean)
  where s.id = input.id;
  get diagnostics v_saved_services = row_count;

  -- Apply new durations and labels to people still waiting. Serving and historical
  -- entries keep their snapshots, so completed history is never rewritten.
  update public.queue_entries q set
    service_name_snapshot = s.name,
    service_duration_minutes_snapshot = s.duration_minutes,
    service_price_cents_snapshot = s.price_cents
  from public.services s
  where q.service_id = s.id and q.status = 'waiting';

  perform public.broadcast_public_queue_update();
  return jsonb_build_object('saved_services', v_saved_services, 'saved_hours', 7);
end;
$$;

revoke all on function public.admin_save_controls(jsonb, jsonb) from public, anon;
grant execute on function public.admin_save_controls(jsonb, jsonb) to authenticated;

commit;
