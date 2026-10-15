# Roteiro manual: concorrência da fila

Execute este roteiro somente em um projeto Supabase de teste, com um usuário de teste já presente em `admin_users` e serviços/clientes marcados como teste. Não use o projeto de produção. As chamadas que alteram a fila são intencionais; registre os UUIDs dos registros de teste para removê-los ao final.

## Pré-requisitos

1. Aplicar manualmente `202610140004_queue_concurrency_notifications.sql` no projeto de teste.
2. Usar um usuário de teste autorizado em `admin_users`.
3. Preparar entradas de teste com os estados necessários (`waiting`, `serving`, `payment_pending` e `cancelled`) e anotar seus UUIDs. Use os serviços já cadastrados no projeto de teste.
4. Para chamadas autenticadas pelo SQL Editor, substitua `UUID_ADMIN_TESTE` e `UUID_ATENDIMENTO_ATUAL` pelos UUIDs do projeto de teste. Em cada sessão SQL:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'UUID_ADMIN_TESTE', true);
```

Execute a RPC da etapa e finalize com `commit;`. Se uma RPC retornar erro, encerre a transação com `rollback;` antes de reutilizar a sessão.

## Verificações funcionais

### Fila vazia

Com nenhuma entrada `waiting` e nenhuma `serving`, chame `select public.admin_start_next_service();`. Esperado: erro controlado informando que não há clientes aguardando; nenhum estado muda.

### Iniciar normalmente e impedir segundo início

Com ao menos uma entrada `waiting`, execute `select public.admin_start_next_service();`. Esperado: a menor `(position_order, id)` passa a `serving`, recebe `started_at` e a resposta contém `queue_entry_id` e `started_at`. Chame novamente: esperado erro de atendimento já em andamento.

### Impedir entrada pendente ou cancelada

Garanta que haja uma entrada `payment_pending` e uma `cancelled`, sem entradas `waiting`; chamar `admin_start_next_service()` deve retornar fila vazia. Nenhuma dessas duas entradas pode mudar de estado.

### Duas chamadas concorrentes de início

Abra duas sessões SQL. Na sessão A, inicie a transação autenticada, adquira o mesmo lock e chame a RPC, mas ainda não confirme:

```sql
select pg_advisory_xact_lock(413528, 1);
select public.admin_start_next_service();
```

Na sessão B, inicie a transação autenticada e chame `select public.admin_start_next_service();`. A chamada B aguardará. Confirme a sessão A. Esperado: B retorna erro de atendimento já em andamento. Deve haver exatamente uma entrada `serving`.

### Duas finalizações concorrentes / repetição de clique

Com um atendimento ativo, anote seu ID. Em duas sessões autenticadas, chame `select public.admin_finish_current_service('UUID_ATENDIMENTO_ATUAL');` usando o mesmo ID. Para tornar a disputa reproduzível, a sessão A pode adquirir primeiro `pg_advisory_xact_lock(413528, 1)`, chamar a RPC e aguardar antes do `commit`. A sessão B chama a mesma RPC enquanto A mantém a transação aberta. Após o commit de A, esperado: B retorna conflito e não finaliza o próximo cliente. O retorno de A deve trazer `completed_queue_entry_id`, `next_queue_entry_id` e `notifications_created`.

### Cadastro ou remoção presencial em paralelo à finalização

Com duas sessões de teste, segure o advisory lock na sessão A, chame `select public.admin_add_walkin('Cliente Teste', '71999990000', 'UUID_SERVICO_TESTE');` ou `select public.admin_remove_queue_entry('UUID_FILA_TESTE');`, e mantenha a transação aberta. Chame a finalização na sessão B com o ID atual e confirme A. Esperado: B só prossegue depois de A; a fila termina com no máximo um `serving`, posições calculadas pela ordem e nenhuma entrada perdida.

### Confirmação Pix em paralelo à fila

No projeto de teste, crie uma entrada `payment_pending` com uma transação de teste pendente. Sem cobrança real, a role `service_role` pode simular a confirmação já verificada chamando a RPC com os valores abaixo, substituindo o UUID pelo ID da transação de teste:

```sql
begin;
set local role service_role;
select public.apply_mercado_pago_order_update(
  'UUID_TRANSACAO_TESTE', 'ORDER_TESTE', 'PAYMENT_TESTE', 'UUID_TRANSACAO_TESTE',
  'processed', 'accredited', 'BRL', 1000, 1000,
  'pix', 'processed', 'accredited', 1000, 1000
);
commit;
```

Para testar concorrência, mantenha o lock da sessão A enquanto a outra sessão inicia/finaliza. Esperado: a confirmação serializa com a operação administrativa; somente a transação aprovada libera `payment_pending` para `waiting`; o início nunca seleciona uma entrada pendente. Não use token de produção nem faça cobrança real.

### Notificações e consulta pública

Após finalizar, confira o último aviso `in_app` por `queue_entry_id`. Ele deve ter `event_type`, posição, pessoas à frente e espera coerentes com `get_public_queue()`. A segunda chamada concorrente com o mesmo `UUID_ATENDIMENTO_ATUAL` deve falhar e não pode criar novas notificações. Um novo atendimento finalizado deve gerar avisos para as mudanças de posição/espera e para o cliente que começou a cortar. Linhas históricas anteriores à migration permanecem sem alteração.

```sql
select queue_entry_id, event_type, queue_position, people_ahead,
       estimated_wait_minutes, message, created_at
from public.notifications
where channel = 'in_app'
order by created_at desc, id desc;

select * from public.get_public_queue();
```

Confirme que o retorno público contém somente `queue_entry_id`, `display_name`, `service_name`, `status`, `position`, `people_ahead`, `estimated_wait_minutes` e `started_at`; telefone, e-mail, pagamentos e tokens não devem aparecer.

### Permissões

Confira as permissões no projeto de teste:

```sql
select
  has_function_privilege('anon', 'public.admin_start_next_service()', 'execute') as anon_can_start,
  has_function_privilege('authenticated', 'public.admin_start_next_service()', 'execute') as auth_can_call_start,
  has_function_privilege('anon', 'public.admin_finish_current_service()', 'execute') as anon_can_finish_legacy,
  has_function_privilege('authenticated', 'public.admin_finish_current_service()', 'execute') as auth_can_call_finish_legacy,
  has_function_privilege('anon', 'public.admin_finish_current_service(uuid)', 'execute') as anon_can_finish,
  has_function_privilege('authenticated', 'public.admin_finish_current_service(uuid)', 'execute') as auth_can_call_finish,
  has_function_privilege('authenticated', 'public.apply_mercado_pago_order_update(uuid,text,text,text,text,text,text,integer,integer,text,text,text,integer,integer)', 'execute') as auth_can_apply_pix,
  has_function_privilege('service_role', 'public.apply_mercado_pago_order_update(uuid,text,text,text,text,text,text,integer,integer,text,text,text,integer,integer)', 'execute') as service_can_apply_pix;
```

Esperado: os dois `anon_can_*` de início/finalização são `false`; os três `auth_can_call_*` são `true`; `auth_can_apply_pix=false`; `service_can_apply_pix=true`. Além do grant, chamadas administrativas feitas por `authenticated` devem ser rejeitadas quando o usuário não está em `admin_users`.

Para testar a validação interna de administrador, use um UUID de usuário de teste que não esteja em `admin_users`:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'UUID_USUARIO_NAO_ADMIN_TESTE', true);
select public.admin_start_next_service(); -- esperado: SQLSTATE 42501
rollback;
```

## Limpeza

Remova apenas UUIDs que foram criados para este roteiro, no projeto de teste. Primeiro apague notificações e transações vinculadas; depois entradas e clientes. Não apague registros históricos fora dos IDs anotados.

```sql
begin;
delete from public.notifications where queue_entry_id in ('UUID_FILA_TESTE_1', 'UUID_FILA_TESTE_2');
delete from public.payment_transactions where queue_entry_id in ('UUID_FILA_TESTE_1', 'UUID_FILA_TESTE_2');
delete from public.queue_entries where id in ('UUID_FILA_TESTE_1', 'UUID_FILA_TESTE_2');
delete from public.clients where id in ('UUID_CLIENTE_TESTE_1', 'UUID_CLIENTE_TESTE_2');
commit;
```

As verificações acima não foram executadas contra o Supabase durante a implementação. Elas dependem de um projeto de teste, do schema base real e de credenciais de teste.
