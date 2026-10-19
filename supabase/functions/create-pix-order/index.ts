
import { createClient } from 'npm:@supabase/supabase-js@2'

const developmentOrigin = 'http://localhost:5173'

const allowedOrigins = new Set([
  developmentOrigin,
  ...(Deno.env.get('FRONTEND_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
])

const getCorsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin':
    origin && allowedOrigins.has(origin) ? origin : developmentOrigin,
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
})

const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
}

const keyedHash = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )

  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        ...getCorsHeaders(origin),
        'Content-Type': 'application/json',
      },
    })

  if (origin && !allowedOrigins.has(origin)) {
    return respond({ error: 'Origem não autorizada.' }, 403)
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    })
  }

  if (request.method !== 'POST') {
    return respond({ error: 'Método não permitido.' }, 405)
  }

  const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')
  const mpMode = Deno.env.get('MERCADOPAGO_MODE')
  const rateLimitSecret = Deno.env.get('CHECKOUT_RATE_LIMIT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseSecretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')

  if (
    !mpToken ||
    !['test', 'production'].includes(mpMode ?? '') ||
    !rateLimitSecret ||
    !supabaseUrl ||
    !supabaseSecretKeys
  ) {
    return respond(
      { error: 'Integração de pagamento ainda não configurada no servidor.' },
      503,
    )
  }

  try {
    const secretKey = JSON.parse(supabaseSecretKeys).default

    if (!secretKey) {
      return respond(
        { error: 'A chave interna do Supabase não está configurada.' },
        503,
      )
    }

    const supabase = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false },
    })

    const body = await request.json()

    const {
      name,
      phone,
      email,
      serviceId,
      requestId,
      checkoutToken,
    } = body ?? {}

    const normalizedName =
      typeof name === 'string' ? name.trim() : ''

    const normalizedPhone =
      typeof phone === 'string' ? phone.replace(/\D/g, '') : ''

    const normalizedEmail =
      typeof email === 'string' ? email.trim().toLowerCase() : ''

    if (
      normalizedName.length < 2 ||
      normalizedName.length > 120 ||
      normalizedPhone.length < 10 ||
      normalizedPhone.length > 13 ||
      typeof serviceId !== 'string' ||
      !uuidPattern.test(serviceId) ||
      typeof requestId !== 'string' ||
      !uuidPattern.test(requestId) ||
      typeof checkoutToken !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(checkoutToken) ||
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return respond(
        {
          error:
            'Confira nome, telefone, serviço, e-mail e tente novamente.',
        },
        400,
      )
    }

    const tokenHash = await sha256(checkoutToken)

    const contactHash = await keyedHash(
      `${normalizedEmail}|${normalizedPhone}`,
      rateLimitSecret,
    )

    const sourceIp = request.headers
      .get('cf-connecting-ip')
      ?.trim()

    const ipHash = sourceIp
      ? await keyedHash(sourceIp, rateLimitSecret)
      : null

    const { data: intent, error: intentError } = await supabase.rpc(
      'create_online_payment_intent',
      {
        p_request_id: requestId,
        p_token_hash: tokenHash,
        p_name: normalizedName,
        p_phone: normalizedPhone,
        p_service_id: serviceId,
        p_payer_email: normalizedEmail,
        p_contact_hash: contactHash,
        p_ip_hash: ipHash,
      },
    )

    if (intentError?.code === 'P0001') {
      return respond({ error: intentError.message }, 429)
    }

    if (intentError) {
      console.error('Payment intent creation failed', {
        code: intentError.code,
        message: intentError.message,
      })

      throw new Error('Não foi possível preparar a intenção de pagamento.')
    }

    if (
      !intent ||
      typeof intent.payment_transaction_id !== 'string' ||
      !uuidPattern.test(intent.payment_transaction_id)
    ) {
      throw new Error('A intenção de pagamento retornou dados inválidos.')
    }

    let order: Record<string, any>

    if (intent.provider_order_id) {
      const lookup = await fetch(
        `https://api.mercadopago.com/v1/orders/${encodeURIComponent(
          intent.provider_order_id,
        )}`,
        {
          headers: {
            Authorization: `Bearer ${mpToken}`,
          },
          signal: AbortSignal.timeout(12000),
        },
      )

      if (!lookup.ok) {
        const errorBody = await lookup.json().catch(() => null)

        console.error('Mercado Pago order lookup failed', {
          status: lookup.status,
          message: errorBody?.message,
          error: errorBody?.error,
          cause: errorBody?.cause,
        })

        throw new Error(
          'Não foi possível recuperar a cobrança Pix existente.',
        )
      }

      order = await lookup.json()
    } else {
      const response = await fetch(
        'https://api.mercadopago.com/v1/orders',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mpToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',

            // A mesma transação reutiliza a mesma chave.
            'X-Idempotency-Key': intent.payment_transaction_id,
          },
          body: JSON.stringify({
            type: 'online',
            total_amount: '10.00',
            external_reference: intent.payment_transaction_id,
            processing_mode: 'automatic',
            transactions: {
              payments: [
                {
                  amount: '10.00',
                  payment_method: {
                    id: 'pix',
                    type: 'bank_transfer',
                  },
                  expiration_time: 'PT24H',
                },
              ],
            },
            payer: {
              email: normalizedEmail,
              first_name: normalizedName.split(/\s+/)[0],
            },
          }),
          signal: AbortSignal.timeout(15000),
        },
      )

      order = await response.json().catch(() => ({}))

      if (!response.ok) {
        console.error('Mercado Pago order creation failed', {
          status: response.status,
          message: order?.message,
          error: order?.error,
          cause: order?.cause,
        })

        return respond(
          {
            error:
              'Não foi possível criar o Pix. Consulte os logs para identificar o motivo.',
          },
          502,
        )
      }
    }

    if (
      !order.id ||
      order.external_reference !== intent.payment_transaction_id ||
      Number(order.total_amount) !== 10
    ) {
      console.error('Mercado Pago order validation failed', {
        hasOrderId: Boolean(order.id),
        hasExpectedReference:
          order.external_reference === intent.payment_transaction_id,
        amountIsCorrect: Number(order.total_amount) === 10,
      })

      return respond(
        { error: 'A referência da cobrança não corresponde à solicitação.' },
        502,
      )
    }

    if (!intent.provider_order_id) {
      const { error: storeError } = await supabase.rpc(
        'record_mercado_pago_order',
        {
          p_transaction_id: intent.payment_transaction_id,
          p_order_id: order.id,
        },
      )

      if (storeError) {
        console.error('Mercado Pago order association failed', {
          code: storeError.code,
          message: storeError.message,
        })

        throw new Error(
          'A cobrança foi criada, mas não pôde ser vinculada. Tente novamente para recuperar a mesma cobrança.',
        )
      }
    }

    const payment = order.transactions?.payments?.find(
      (item: Record<string, any>) =>
        item.payment_method?.id === 'pix',
    )

    const qrCode = payment?.payment_method?.qr_code
    const qrCodeBase64 = payment?.payment_method?.qr_code_base64
    const ticketUrl = payment?.payment_method?.ticket_url

    if (
      typeof qrCode !== 'string' ||
      qrCode.trim().length === 0 ||
      typeof qrCodeBase64 !== 'string' ||
      qrCodeBase64.length === 0
    ) {
      console.error('Mercado Pago order has no usable Pix QR data', {
        orderId: order.id,
        orderStatus: order.status,
        orderStatusDetail: order.status_detail,
        paymentStatus: payment?.status,
        paymentStatusDetail: payment?.status_detail,
        hasQrCode: typeof qrCode === 'string' && qrCode.length > 0,
        hasQrCodeBase64:
          typeof qrCodeBase64 === 'string' && qrCodeBase64.length > 0,
      })

      return respond(
        {
          error:
            'O Mercado Pago não retornou um Pix válido para esta cobrança. Consulte os logs.',
        },
        502,
      )
    }

    return respond({
      requestId,
      status: order.status,
      statusDetail: order.status_detail,
      amountCents: 1000,
      qrCode,
      qrCodeBase64,
      ticketUrl: typeof ticketUrl === 'string' ? ticketUrl : null,
    })
  } catch (error) {
    console.error('Pix checkout request failed', {
      message:
        error instanceof Error
          ? error.message
          : 'unknown error',
    })

    return respond(
      {
        error:
          'Não foi possível preparar o pagamento agora. Tente novamente.',
      },
      500,
    )
  }
})
