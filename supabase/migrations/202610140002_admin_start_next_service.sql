-- Starts the first waiting entry without changing the existing RLS policies.
-- The table lock serializes this RPC with queue writes, including the existing
-- admin_finish_current_service() function, so two entries cannot become serving.

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
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
  ) then
    raise exception 'Acesso administrativo não autorizado.'
      using errcode = '42501';
  end if;

  -- Conflicts with the ROW EXCLUSIVE lock used by INSERT/UPDATE/DELETE,
  -- including admin_finish_current_service(), and is held until this RPC ends.
  lock table public.queue_entries in share row exclusive mode;

  if exists (
    select 1
    from public.queue_entries q
    where q.status = 'serving'
  ) then
    raise exception 'Já existe um atendimento em andamento. Finalize o corte atual antes de iniciar outro.'
      using errcode = '55000';
  end if;

  select q.id
    into v_queue_entry_id
  from public.queue_entries q
  where q.status = 'waiting'
  order by q.position_order, q.id
  limit 1
  for update;

  if v_queue_entry_id is null then
    raise exception 'Não há clientes aguardando na fila.'
      using errcode = 'P0002';
  end if;

  update public.queue_entries q
  set status = 'serving',
      started_at = v_started_at
  where q.id = v_queue_entry_id
    and q.status = 'waiting';
  get diagnostics v_rows = row_count;

  if v_rows <> 1 then
    raise exception 'A fila mudou antes de iniciar o atendimento. Atualize e tente novamente.'
      using errcode = '40001';
  end if;

  perform public.broadcast_public_queue_update();

  return jsonb_build_object(
    'queue_entry_id', v_queue_entry_id,
    'started_at', v_started_at
  );
end;
$$;

revoke all on function public.admin_start_next_service() from public, anon;
grant execute on function public.admin_start_next_service() to authenticated;
