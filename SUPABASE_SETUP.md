# Supabase e Pix de teste

## Estado de aplicação

As migrations `202610140001_safe_queue_rpc.sql` e `202610140002_admin_start_next_service.sql` já existiam no projeto. A migration `202610140003_mercado_pago_pix.sql` foi criada, mas **não foi aplicada**. Revise o SQL antes de executá-lo no SQL Editor do projeto Supabase.

Ela altera somente colunas e funções de `payment_transactions`, `queue_entries`, `clients` e `services` já existentes. Não cria tabelas nem muda políticas RLS. As RPCs de cobrança e consulta são concedidas exclusivamente à role interna `service_role`.

## Secrets das Edge Functions

Em Supabase → Project Settings → Edge Functions → Secrets, configure:

- `MERCADOPAGO_ACCESS_TOKEN`: Access Token de **teste** da aplicação Mercado Pago. O código usa `Deno.env.get`; nunca configure esse valor com prefixo `VITE_` nem o envie ao React.
- `MERCADOPAGO_MODE`: configure exatamente `test`. As funções de criação e webhook ficam indisponíveis se esse marcador não estiver configurado.
- `MERCADOPAGO_WEBHOOK_SECRET`: chave exclusiva gerada na configuração Webhooks da aplicação Mercado Pago.
- `CHECKOUT_RATE_LIMIT_SECRET`: segredo aleatório forte usado para gerar HMACs dos identificadores de contato/IP antes de salvá-los como chaves de limite. Nunca use o valor no frontend.
- `FRONTEND_ORIGINS`: lista separada por vírgulas das origens do frontend, incluindo esquema e porta, por exemplo a origem local de desenvolvimento e o domínio final. As funções de checkout/status rejeitam origens de navegador fora dessa lista.

As funções usam também os Secrets Supabase gerenciados pela plataforma (`SUPABASE_URL` e `SUPABASE_SECRET_KEYS`). A chave interna do Supabase é usada somente dentro das Edge Functions para chamar as RPCs privilegiadas; nunca a publique no frontend.

Não configure credenciais de produção nesta etapa. O prefixo do Access Token, sozinho, não diferencia credenciais de teste e produção; copie-o explicitamente da área **Testes → Credenciais de teste** do Mercado Pago.

## Arquivos de função

- `create-pix-order`: cria ou recupera a mesma intenção idempotente e chama `POST /v1/orders` com Pix e valor fixo `10.00`.
- `get-pix-status`: consulta somente o estado ligado ao token de checkout, sem devolver nome, telefone ou transação.
- `mercado-pago-webhook`: valida a assinatura `x-signature`, consulta `GET /v1/orders/{id}` no Mercado Pago e aplica somente o resultado confirmado.

As funções são públicas no gateway (`verify_jwt = false`) porque o checkout e o webhook são acessados sem sessão administrativa. Isso **não** libera leitura/escrita pública nas tabelas. As rotas validam seus próprios dados; o endpoint de status exige o token aleatório do checkout e limita consultas por solicitação. A migration inclui limites persistentes por hash de contato (5 por hora) e, quando o cabeçalho confiável `cf-connecting-ip` estiver disponível, por IP (10 por hora). As chamadas repetidas da mesma solicitação idempotente não consomem novas tentativas. As origens do React são limitadas pela lista `FRONTEND_ORIGINS`. CORS não substitui rate limiting contra clientes automatizados; considere proteção adicional no gateway/WAF para tráfego distribuído.

## Aplicar a migration manualmente

1. Abra `supabase/migrations/202610140003_mercado_pago_pix.sql` e revise o conteúdo.
2. No Supabase, abra SQL Editor → New query.
3. Cole o arquivo inteiro e execute. A migration não é aplicada pela aplicação React nem pelo build.
4. Confirme que a execução terminou sem erro antes de publicar as funções.

## Publicar e configurar o webhook

1. Faça deploy das funções `create-pix-order`, `get-pix-status` e `mercado-pago-webhook` no projeto Supabase.
2. Confirme que os Secrets acima estão presentes sem exibir/copiar valores em logs.
3. No Mercado Pago Developers, selecione a aplicação e abra **Webhooks → Configurar notificações**.
4. Na aba de teste, informe a URL HTTPS `https://<PROJECT_REF>.supabase.co/functions/v1/mercado-pago-webhook` e selecione o evento **Order (Mercado Pago)**. Salve e copie a chave de assinatura recém-gerada para `MERCADOPAGO_WEBHOOK_SECRET`.
5. Use a opção Simular para verificar a entrega. Um pedido de teste real só deve ser feito com vendedor e comprador de teste.

## Fluxo e segurança

O navegador envia nome, telefone, serviço, e-mail e identificadores aleatórios de repetição/checkout. O backend valida o serviço ativo e calcula os R$ 10. O banco cria cliente, entrada online `payment_pending` e transação `pending` dentro da mesma transação. O nome/serviço/valor snapshot são preservados conforme o schema atual.

O Access Token nunca sai da Edge Function. Retries reaproveitam o identificador de solicitação e o mesmo `X-Idempotency-Key`; uma Order criada antes de um timeout pode ser recuperada pelo mesmo identificador. O webhook não confia no corpo como prova: valida HMAC, consulta a Order com o Access Token e confere referência, moeda, valor e status do pedido e do pagamento. Somente `processed`/`accredited`, com pagamento Pix de R$ 10 integral, libera `payment_pending` para `waiting`.

O cliente pode consultar apenas seu próprio estado com o token do checkout. Nenhuma função pública devolve telefone, e-mail, chave Pix, transação ou nome de outro cliente. Pagamentos pendentes, falhos e expirados não entram na fila pública. O QR Code e o Pix copia e cola são mostrados ao pagador que fez a solicitação.

## Teste manual depois da aplicação

1. Configure a URL e a chave pública Supabase do frontend em `.env.local` (chave pública, não `service_role`). Esse arquivo está ignorado pelo Git.
2. Use a tela `/entrar-na-fila` com dados de teste e um serviço ativo.
3. Confira a exibição do QR Code, Pix copia e cola e link do Mercado Pago.
4. Conclua o fluxo usando as contas de teste do Mercado Pago; não use sua conta real como comprador.
5. Confira que antes da confirmação a entrada permanece `payment_pending` e não aparece em `get_public_queue()`; depois, que só a confirmação do webhook a transforma em `waiting`.
6. Reenvie a notificação de teste e confira que não cria outra transação nem entrada.

O build local não testa credenciais, SQL, webhook ou uma compra. Esses pontos dependem da aplicação manual da migration, publicação das funções e validação com contas de teste no Supabase/Mercado Pago.
