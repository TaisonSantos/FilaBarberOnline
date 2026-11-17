import { createClient } from 'npm:@supabase/supabase-js@2'

const developmentOrigin = 'http://localhost:5173'
const productionOrigin = 'https://fila-barber-online.vercel.app'
const allowedOrigins = new Set([
  developmentOrigin,
  productionOrigin,
  ...(Deno.env.get('FRONTEND_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
])
const getCorsHeaders = (origin: string | null) => ({
  // A disallowed origin receives a non-matching explicit origin so browsers
  // reject it, while every response avoids the invalid literal "null".
  'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : developmentOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
})
const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('')
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cents = (value: unknown) => Math.round(Number(value) * 100)

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...getCorsHeaders(origin), 'Content-Type': 'application/json' },
  })
  if (origin && !allowedOrigins.has(origin)) return respond({ error: 'Origem não autorizada.' }, 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: getCorsHeaders(origin) })
  if (request.method !== 'POST') return respond({ error: 'Método não permitido.' }, 405)
  try {
    const { requestId, checkoutToken } = await request.json()
    if (typeof requestId !== 'string' || !uuidPattern.test(requestId)
      || typeof checkoutToken !== 'string' || !/^[0-9a-f]{64}$/i.test(checkoutToken)) {
      return respond({ error: 'Dados de consulta inválidos.' }, 400)
    }
    const secrets = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    const key = secrets.default
    const url = Deno.env.get('SUPABASE_URL')
    if (!url || !key) return respond({ error: 'Consulta de pagamento indisponível.' }, 503)
    const supabase = createClient(url, key, { auth: { persistSession: false } })
    const tokenHash = await sha256(checkoutToken)
    const { data, error } = await supabase.rpc('get_online_payment_status', {
      p_request_id: requestId,
      p_token_hash: tokenHash,
    })
    if (error) {
      console.error('Payment status lookup failed', { code: error.code })
      if (error.code === 'P0002') return respond({ error: 'Pagamento não encontrado.' }, 404)
      if (error.code === 'P0001') return respond({ error: 'Muitas consultas. Aguarde um minuto e tente novamente.' }, 429)
      return respond({ error: 'Não foi possível consultar o pagamento.' }, 500)
    }
    let result = Array.isArray(data) ? data[0] : data
    if (!result || typeof result !== 'object') return respond({ error: 'Pagamento não encontrado.' }, 404)
    if (result.rate_limited) return respond({ error: 'Muitas consultas. Aguarde um minuto e tente novamente.' }, 429)

    // Webhooks are the primary notification path. Verify pending orders during
    // polling as a fallback so a delayed/missed webhook cannot strand a paid
    // customer outside the queue. The order id comes from the token-protected
    // database lookup; the database RPC validates its reference and amounts.
    if (result.status === 'pending' && typeof result.provider_order_id === 'string') {
      const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')
      if (accessToken) {
        try {
          const providerResponse = await fetch(
            `https://api.mercadopago.com/v1/orders/${encodeURIComponent(result.provider_order_id)}`,
            {
              headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
              signal: AbortSignal.timeout(10000),
            },
          )

          if (providerResponse.ok) {
            const order = await providerResponse.json()
            const payment = order.transactions?.payments?.find(
              (item: Record<string, any>) => item.payment_method?.id === 'pix',
            )
            const currencyId = order.currency_id ?? (order.country_code === 'BRA' ? 'BRL' : null)

            if (
              order.id === result.provider_order_id &&
              order.type === 'online' &&
              typeof order.external_reference === 'string' &&
              payment &&
              currencyId === 'BRL'
            ) {
              const { data: applied, error: applyError } = await supabase.rpc(
                'apply_mercado_pago_order_update',
                {
                  p_transaction_id: order.external_reference,
                  p_order_id: order.id,
                  p_payment_id: payment.id,
                  p_external_reference: order.external_reference,
                  p_order_status: order.status,
                  p_order_status_detail: order.status_detail,
                  p_currency_id: currencyId,
                  p_total_amount_cents: cents(order.total_amount),
                  p_total_paid_cents: cents(order.total_paid_amount),
                  p_payment_method_id: payment.payment_method?.id,
                  p_payment_status: payment.status,
                  p_payment_status_detail: payment.status_detail,
                  p_payment_amount_cents: cents(payment.amount),
                  p_paid_amount_cents: cents(payment.paid_amount),
                },
              )

              if (applyError) {
                console.error('Verified order update failed during status polling', {
                  code: applyError.code,
                })
              } else {
                const appliedResult = Array.isArray(applied) ? applied[0] : applied
                if (appliedResult && typeof appliedResult === 'object') {
                  result = {
                    ...result,
                    status: appliedResult.payment_status,
                    queue_status: appliedResult.queue_status,
                  }
                }
              }
            } else {
              console.error('Mercado Pago order did not match pending Pix', {
                idMatches: order.id === result.provider_order_id,
                isOnlineOrder: order.type === 'online',
                hasReference: typeof order.external_reference === 'string',
                hasPixPayment: Boolean(payment),
                currencyId,
              })
            }
          } else {
            console.error('Pending Mercado Pago order lookup failed', {
              status: providerResponse.status,
            })
          }
        } catch (providerError) {
          console.error('Pending Mercado Pago order verification failed', {
            message: providerError instanceof Error ? providerError.message : 'unknown error',
          })
        }
      }
    }

    return respond({
      status: result.status,
      queueStatus: result.queue_status,
      paidAt: result.paid_at,
      queueEntryId: result.queue_entry_id,
    })
  } catch (error) {
    console.error('Pix status lookup failed', { message: error instanceof Error ? error.message : 'unknown error' })
    return respond({ error: 'Não foi possível consultar o pagamento agora.' }, 500)
  }
})
