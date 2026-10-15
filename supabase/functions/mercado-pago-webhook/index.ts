import { createClient } from 'npm:@supabase/supabase-js@2'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const cents = (value: unknown) => Math.round(Number(value) * 100)

async function validSignature(signature: string, requestId: string, dataId: string, secret: string) {
  const parts = Object.fromEntries(signature.split(',').map((part) => {
    const [key, ...rest] = part.trim().split('=')
    return [key, rest.join('=')]
  }))
  if (!parts.ts || !parts.v1) return false
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  const expected = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
  if (expected.length !== parts.v1.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i)
  return mismatch === 0
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')
  const mpMode = Deno.env.get('MERCADOPAGO_MODE')
  const webhookSecret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!accessToken || mpMode !== 'test' || !webhookSecret || !supabaseUrl || !secretKeys) return json({ error: 'Webhook not configured' }, 503)

  try {
    const url = new URL(request.url)
    const dataId = url.searchParams.get('data.id')
    const topic = url.searchParams.get('type')
    const signature = request.headers.get('x-signature')
    const requestId = request.headers.get('x-request-id')
    if (topic !== 'order' || !dataId || !signature || !requestId) return json({ error: 'Invalid notification' }, 400)
    if (!await validSignature(signature, requestId, dataId, webhookSecret)) return json({ error: 'Invalid signature' }, 401)
    const notification = await request.json()
    if (notification?.type !== 'order' || String(notification?.data?.id ?? '') !== dataId) {
      return json({ error: 'Notification payload mismatch' }, 400)
    }

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!mpResponse.ok) {
      console.error('Order verification failed', { status: mpResponse.status })
      return json({ error: 'Could not verify order' }, 502)
    }
    const order = await mpResponse.json()
    if (order.id !== dataId || order.type !== 'online') return json({ error: 'Order mismatch' }, 400)
    const payment = order.transactions?.payments?.find((item: Record<string, any>) => item.payment_method?.id === 'pix')
    if (!payment) return json({ error: 'Pix transaction not found' }, 400)

    const secret = JSON.parse(secretKeys).default
    if (!secret) return json({ error: 'Supabase internal key unavailable' }, 503)
    const supabase = createClient(supabaseUrl, secret, { auth: { persistSession: false } })
    const { error } = await supabase.rpc('apply_mercado_pago_order_update', {
      p_transaction_id: order.external_reference,
      p_order_id: order.id,
      p_payment_id: payment.id,
      p_external_reference: order.external_reference,
      p_order_status: order.status,
      p_order_status_detail: order.status_detail,
      p_currency_id: order.currency_id,
      p_total_amount_cents: cents(order.total_amount),
      p_total_paid_cents: cents(order.total_paid_amount),
      p_payment_method_id: payment.payment_method?.id,
      p_payment_status: payment.status,
      p_payment_status_detail: payment.status_detail,
      p_payment_amount_cents: cents(payment.amount),
      p_paid_amount_cents: cents(payment.paid_amount),
    })
    if (error) {
      console.error('Verified order update failed', { code: error.code })
      return json({ error: 'Could not update payment state' }, 500)
    }
    return json({ received: true }, 200)
  } catch (error) {
    console.error('Mercado Pago webhook failed', { message: error instanceof Error ? error.message : 'unknown error' })
    return json({ error: 'Webhook processing failed' }, 500)
  }
})
