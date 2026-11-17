begin;

-- Add an index for the service foreign key used by queue lookups and service maintenance.
create index if not exists idx_queue_entries_service_id
  on public.queue_entries (service_id);

-- Keep one public active-services SELECT policy; both policies had identical scope.
drop policy if exists servicos_publicos_ativos on public.services;

-- Cache auth.uid() once per statement instead of once per candidate row.
drop policy if exists admin_consulta_proprio_acesso on public.admin_users;
create policy admin_consulta_proprio_acesso
  on public.admin_users
  for select
  to authenticated
  using (user_id = (select auth.uid()));

commit;
