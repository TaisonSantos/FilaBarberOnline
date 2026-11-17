# Auditoria técnica do SC Barber

Data: 2026-11-16

## Escopo e limites

Esta auditoria cobre os arquivos disponíveis no workspace: aplicação React/Vite, configuração de build e deploy, migrations SQL versionadas e três Edge Functions. Não houve conexão administrativa com Supabase ou Vercel. Portanto, não foi possível confirmar o schema remoto completo, políticas RLS existentes, migrations já aplicadas, secrets, configurações de projeto, logs ou estado de deploy. O repositório não contém as migrations-base que criam `clients`, `services`, `queue_entries`, `payment_transactions`, `notifications` e `admin_users`; as migrations examinadas assumem que essas tabelas já existem.

## Achados e correções

### Privacidade da fila pública — corrigido no código

Antes da correção, `get_public_queue()` devolvia `clients.name` sem mascaramento. A mesma RPC alimenta a consulta pública e as mensagens Realtime, então qualquer visitante podia ver nomes completos de quem aguardava ou estava em atendimento. A migration `20261116171552_mask_public_queue_names.sql` preserva o contrato da RPC e limita o campo público ao primeiro nome; ela foi aplicada ao projeto remoto na etapa de correções descrita ao final deste relatório.

### Mensagem de configuração do Supabase — corrigido no código

O cliente aceita `VITE_SUPABASE_ANON_KEY` e `VITE_SUPABASE_KEY`, mas a mensagem de erro da API recomendava a primeira como principal embora o exemplo documentado use `VITE_SUPABASE_ANON_KEY`. A orientação foi alinhada para refletir os nomes aceitos.

## Revisão estática

### Frontend

- A aplicação usa React 18, React Router 6, Vite, Supabase JS e CSS próprio. O entrypoint está em `src/main.jsx`; `src/App.jsx` contém as rotas e telas.
- A área do proprietário verifica a sessão e consulta `admin_users`; páginas administrativas só são renderizadas quando a conta é autorizada. As RPCs administrativas nas migrations também verificam a associação em `admin_users`.
- A fila pública usa RPC segura em vez de leitura direta de telefones e atualiza por consulta periódica; os canais Realtime são removidos no cleanup da inscrição.
- O formulário de entrada depende de configuração e recursos remotos para criar Pix. O código mantém identificadores e token de checkout em `sessionStorage` para reutilizar tentativas idempotentes.
- O build não pôde ser validado neste ambiente: `npm run build` e `npm.cmd run build` encerraram antes de executar o Vite, com `EPERM` ao acessar `C:\Users\user`. Não há resultado de compilação a reportar.
- Não foi feita auditoria visual em navegador/dispositivos nem execução de fluxos contra dados reais.

### Supabase, banco e RLS

- As migrations disponíveis definem RPCs `SECURITY DEFINER` com `search_path` fixo e revogam/concedem execução por função. As operações administrativas verificam `auth.uid()` contra `admin_users`; as RPCs de pagamento são concedidas apenas a `service_role`.
- `business_hours` ativa RLS e o acesso público a horários passa por uma RPC de leitura. As tabelas-base e suas policies não estão no repositório; não é possível atestar RLS, grants, constraints, índices e relacionamentos dessas tabelas sem o projeto remoto ou as migrations originais.
- Não há migrations versionadas para buckets de Storage nem configuração de subscriptions/tabelas no Realtime além do broadcast usado pelo código. Não foi possível inventariar recursos remotos.
- Não há evidência local suficiente para verificar dados inconsistentes, planos de consulta, índices existentes ou uso indevido de políticas no projeto hospedado.

### Edge Functions e pagamentos

- As três funções tratam CORS/métodos, validam campos, usam segredos apenas no servidor e fazem chamadas externas com timeout. O webhook verifica assinatura e consulta a Order no Mercado Pago antes de atualizar o banco; a RPC aplica validações de valor, moeda, referência e estado. O fluxo usa chave idempotente por transação.
- `verify_jwt = false` está configurado para checkout, status e webhook; é coerente com o fluxo público documentado, que substitui a sessão por identificadores/token aleatórios no checkout e assinatura no webhook. A proteção efetiva depende também de secrets e migrations corretos no Supabase.
- Não foi possível confirmar secrets, origem de frontend autorizada, logs de runtime, entrega de webhook, limites reais do gateway ou comportamento com credenciais do Mercado Pago.

### Vercel e infraestrutura

- `vercel.json` contém rewrite de SPA para `/index.html`, adequado às rotas do React Router.
- O workspace não informa Build Command, Output Directory, Framework Preset, Root Directory, variáveis por ambiente, domínios, logs ou deploys do painel Vercel. A configuração efetiva precisa ser confirmada no projeto.
- A configuração não define headers HTTP de segurança explicitamente. Nenhuma mudança foi aplicada nesse ponto porque CSP e domínios externos precisam ser validados contra os domínios reais do Supabase e do Mercado Pago.

## Pendências para validação de ponta a ponta

1. Aplicar a nova migration de mascaramento depois das migrations de fila existentes.
2. Comparar todas as migrations e policies do projeto Supabase com o repositório; confirmar RLS e grants nas tabelas-base, `admin_users`, Storage e Realtime.
3. Conferir secrets e `FRONTEND_ORIGINS` em Development/Preview/Production, e validar webhook/testes Mercado Pago sem pagamentos reais.
4. Conferir configuração e logs de build/deploy da Vercel e repetir o build em ambiente com acesso ao runtime Node.

## Continuação da revisão estática — 2026-11-16

### Fluxos de acesso e dados

- Revistos os pontos de acesso do frontend em `src/lib/barberApi.js` e `src/auth/AuthProvider.jsx`. A chave usada no navegador é a chave pública; não há referência local à `service_role` no frontend. Leituras administrativas de clientes, fila, pagamentos e notificações são consultas diretas às tabelas e dependem integralmente das policies RLS do projeto remoto, ausentes deste repositório.
- As RPCs administrativas incluídas nas migrations conferem a associação do usuário em `admin_users` dentro do banco; a autorização visual no React não é a única barreira para essas operações.
- A inscrição Realtime pública recebe apenas o broadcast construído por `get_public_queue()`. A remoção do canal ocorre no cleanup do componente; a migration de mascaramento preserva essa rota de dados.
- Não encontrei exposição de telefone/e-mail nas RPCs ou respostas públicas de pagamento revisadas. A consulta de status exige o identificador da solicitação e o token de checkout, e a função de pagamento usa a chave interna somente no servidor.

### Risco residual no estado de autenticação do frontend

- `AuthProvider` troca a sessão antes de concluir a nova consulta de autorização e não limpa `isAdmin` imediatamente quando recebe uma sessão autenticada diferente. Em uma troca de usuário feita fora do fluxo normal do painel, a interface pode manter conteúdo administrativo renderizado enquanto a consulta de `admin_users` está pendente. As operações de banco continuam protegidas pelas RPCs/policies, mas as leituras diretas dependem das policies remotas. Tratar como hardening de interface; não foi alterado sem poder validar as policies-base e a transição de sessão no projeto.

### Resultado desta etapa

- Não foi possível confirmar achado adicional de severidade alta no código local revisado.
- Naquele ponto da auditoria, ainda estavam pendentes as verificações que exigem acesso autenticado ao Supabase/Vercel. O acesso e as correções remotas foram concluídos depois; consulte a seção final para o estado atual.
- O build e os fluxos com provedor de pagamento não foram repetidos nesta etapa; a execução anterior do build já havia parado por `EPERM` antes de iniciar o Vite.

## Continuação — verificação de acesso aos painéis (2026-11-16)

### Supabase

- O workspace está vinculado ao projeto `efnkovfnyywicoafftkb` (nome no vínculo local: `TaisonSantos's Project`). Isso confirma apenas o vínculo local, não o estado do banco remoto.
- A tentativa de listar projetos pelo conector Supabase falhou com `Unknown tool`; portanto, não foi possível consultar advisors, migrations aplicadas, tabelas/policies, secrets ou logs do projeto remoto nesta sessão.
- A documentação oficial consultada não indica breaking change aplicável ao fluxo usado pelo projeto: a alteração recente da CLI v3 afeta principalmente comandos da CLI; não altera as RPCs, o cliente JS ou as Edge Functions deste app. O workspace usa Supabase JS v2 e não conseguiu iniciar a CLI local porque o runtime foi bloqueado por `EPERM` ao resolver `C:\Users\user`.

### Vercel

- Não foi encontrada configuração local `.vercel` nem variável de ambiente com nome Vercel; o executável `vercel` não está disponível no ambiente.
- Assim, não foi possível confirmar projeto vinculado, variáveis por ambiente, configuração efetiva de build/output, domínios, deployments, logs ou headers enviados pelo edge.
- A única evidência local continua sendo `vercel.json`, com rewrite de SPA para `/index.html`. O valor de `VITE_SUPABASE_URL` e a existência da chave pública foram mantidos fora deste relatório para não registrar dados de configuração local.

### Resultado desta etapa

- Nenhuma alteração foi feita nos projetos hospedados. As verificações administrativas do Supabase e da Vercel permanecem pendentes porque os conectores e a CLI não estão disponíveis nesta sessão; o vínculo local do Supabase, por si só, não autoriza concluir que as migrations/secrets/deploy estão corretos.
- Para fechar a auditoria remota, esta sessão precisa estar autenticada/conectada aos painéis Supabase e Vercel, ou ter os conectores/CLI correspondentes disponíveis. Depois disso, revisar primeiro advisors e migrations Supabase; na Vercel, revisar configurações e logs do deployment ativo, sem exibir valores de secrets.

## Verificação remota inicial Supabase — 2026-11-16 (antes das correções)

O acesso ao projeto `efnkovfnyywicoafftkb` foi confirmado. Projeto ativo e saudável na região `us-east-2`, PostgreSQL 17.11.003.

### Achado alto — nomes completos expostos na fila pública

- Na verificação inicial, as migrations remotas estavam aplicadas até `202611120001_admin_controls`; a migration de mascaramento ainda não constava no histórico remoto. Ela foi aplicada depois como `20261116171552_mask_public_queue_names`.
- A definição remota de `public.get_public_queue()` ainda retorna `clients.name` sem máscara. A função é executável por `anon`, então nome e sobrenome dos clientes atualmente aguardando ou em atendimento estão acessíveis publicamente. Isso confirma o achado de privacidade e a necessidade da migration de mascaramento.
- Não apliquei a migration nesta auditoria. O código SQL pode ser revisado e a correção preparada localmente, mas aplicar DDL no banco remoto mudaria o comportamento de produção e não foi solicitado.

### Políticas, funções e advisories

- RLS está habilitado nas sete tabelas públicas inventariadas. As políticas administrativas de fila, clientes, serviços, pagamentos e notificações restringem acesso ao usuário associado a `admin_users`. `business_hours` não tem policy; a leitura pública usa uma RPC `SECURITY DEFINER` própria, enquanto a edição ocorre por RPC administrativa com checagem de proprietário.
- O Advisor sinaliza RPCs `SECURITY DEFINER` executáveis por `anon`/`authenticated`. A inspeção das definições confirmou que as duas RPCs públicas (`get_public_queue`, `get_public_business_hours`) são rotas intencionais e que as RPCs administrativas verificam `auth.uid()` contra `admin_users`, com `search_path` fixo. Esses alertas são informativos neste caso, embora dependam de manter essas checagens em futuras alterações.
- A proteção Auth contra senhas vazadas está desativada (aviso de segurança).
- Advisories de desempenho: FK `queue_entries.service_id` sem índice; policy `admin_consulta_proprio_acesso` avalia `auth.uid()` por linha; duas políticas permissivas sobrepostas de leitura de `services`; sete índices sem uso observado. Como o projeto tem poucas linhas e pouco histórico, não recomendo remover índices com base apenas nesse aviso.
- O Advisor de saúde não retornou alertas. As três Edge Functions de Pix/webhook estão ativas; `verify_jwt = false` corresponde à configuração versionada e ao fluxo público documentado, que faz autenticação própria nos handlers.

### Vercel

- A equipe `taisonsantos` autorizou a consulta. Foi localizado o projeto `fila-barber-online` (Vite), com domínio `fila-barber-online.vercel.app` verificado.
- O deployment de produção mais recente está `READY`, aponta para `master` no commit `b3b91570` e corresponde ao `HEAD` local. O log confirma `npm run build` → `vite build`, com saída em `dist/`, compilação concluída em cerca de 3,4 s e deployment concluído. Houve avisos do npm sobre `cache-dir` desconhecido e script de instalação do `esbuild` não aprovado; não impediram esse build.
- A consulta retornou lista vazia de variáveis de ambiente do projeto e zero variáveis ocultas de produção. Como o frontend exige `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, isso sugere possível build sem conexão ao Supabase e uso do modo demonstração. Não foi possível confirmar os valores efetivamente incorporados no bundle: a leitura de arquivos do deployment falhou no endpoint da Vercel com `Invalid API version`. Não foram lidos nem exibidos valores secretos.
- Não houve contagem de erros/fatals de runtime nos últimos 30 minutos. A janela de 1 hora foi recusada por exceder a retenção do plano Hobby; a consulta foi refeita dentro da janela aceita.
- A configuração do projeto informa proteção SSO ativada para deployments exceto domínios customizados e proteção por senha desativada. O domínio Vercel listado está verificado; confirmar no navegador o comportamento público da rota protegida não fez parte desta consulta.
- Até aquele ponto da auditoria, nenhuma configuração havia sido alterada na Vercel ou no Supabase.

## Correções aplicadas — 2026-11-16

### Supabase

- Aplicadas as migrations `20261116171552_mask_public_queue_names`, `20261116171952_optimize_queue_and_rls_policies` e `20261116172032_scope_public_services_policy`; os arquivos locais correspondentes acompanham o histórico remoto.
- A verificação da RPC retornou três entradas ativas, todas com somente o primeiro nome; nenhuma continha sobrenome.
- O índice da FK `queue_entries.service_id` foi criado; a policy duplicada de serviços foi removida; a leitura pública de serviços ficou restrita à role `anon`; a policy `admin_consulta_proprio_acesso` agora avalia `(select auth.uid())`.
- Os avisos genéricos de `SECURITY DEFINER` permanecem porque as RPCs públicas são intencionais e as administrativas verificam `auth.uid()` contra `admin_users`. O alerta de RLS sem policy em `business_hours` também permanece por desenho: leitura pública via RPC e escrita via RPC administrativa.
- A proteção contra senhas vazadas segue desativada. A organização está no plano Free e a documentação Supabase informa que esse recurso requer Pro ou superior. Não houve upgrade, que teria custo. O Advisor ainda marca oito índices como não usados; foram mantidos porque a base tem pouco histórico e esses avisos não justificam remover índices úteis por precaução.

### Vercel

- Criadas `VITE_SUPABASE_URL` e `VITE_SUPABASE_KEY` com a URL e chave publishable públicas corretas nos ambientes `development`, `preview` e `production`. Nenhuma chave `service_role` foi enviada à Vercel.
- O projeto foi redeployado do commit `b3b91570` (o mesmo `HEAD` local). O novo deployment está `READY` e recebeu o alias `fila-barber-online.vercel.app`; o build terminou sem erros.

### Estado final

- O achado alto de privacidade da fila foi corrigido e verificado no banco. A conexão do frontend foi configurada e o novo deployment de produção concluiu.
- O único alerta de segurança confirmado que depende de uma mudança de plano é a proteção contra senhas vazadas. Permanece desativada enquanto o projeto estiver no plano Free.
