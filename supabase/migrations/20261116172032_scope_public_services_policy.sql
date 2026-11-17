begin;

-- Public visitors use anon. Authenticated access is limited to admins through
-- admin_gerencia_servicos, which verifies membership in admin_users.
alter policy "Leitura pública de serviços ativos"
  on public.services
  to anon;

commit;
