import { createClient } from 'npm:@supabase/supabase-js@2'

const developmentOrigin = 'http://localhost:5173'
const allowedOrigins = new Set([
  developmentOrigin,
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
    const { data, error } = await supabase.rpc('get_online_payment_status', {
      p_request_id: requestId,
      p_token_hash: await sha256(checkoutToken),
    })
    if (error) {
      console.error('Payment status lookup failed', { code: error.code })
      if (error.code === 'P0002') return respond({ error: 'Pagamento não encontrado.' }, 404)
      if (error.code === 'P0001') return respond({ error: 'Muitas consultas. Aguarde um minuto e tente novamente.' }, 429)
      return respond({ error: 'Não foi possível consultar o pagamento.' }, 500)
    }
    const result = Array.isArray(data) ? data[0] : data
    if (!result || typeof result !== 'object') return respond({ error: 'Pagamento não encontrado.' }, 404)
    if (result.rate_limited) return respond({ error: 'Muitas consultas. Aguarde um minuto e tente novamente.' }, 429)
    return respond({ status: result.status, queueStatus: result.queue_status, paidAt: result.paid_at })
  } catch (error) {
    console.error('Pix status lookup failed', { message: error instanceof Error ? error.message : 'unknown error' })
    return respond({ error: 'Não foi possível consultar o pagamento agora.' }, 500)
  }
})
