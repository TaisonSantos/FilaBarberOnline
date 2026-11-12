import { isSupabaseConfigured, supabase } from './supabase'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Configure VITE_SUPABASE_URL e VITE_SUPABASE_KEY (ou VITE_SUPABASE_ANON_KEY) em .env.local.')
  }
  return supabase
}

function throwQueueOperationError(error) {
  if (error?.code === '40001') {
    throw new Error('A fila mudou enquanto a operação aguardava. Os dados foram atualizados; confira o estado atual e tente novamente.')
  }
  if (error?.code === '55000' && error.message) throw new Error(error.message)
  throw error
}

export async function fetchActiveServices() {
  const client = requireSupabase()
  const { data, error } = await client
    .from('services')
    .select('id,name,duration_minutes,price_cents,active')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return data ?? []
}

export async function fetchPublicBusinessHours() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_public_business_hours')
  if (error) throw error
  return data ?? []
}

export async function fetchAdminControls() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_controls')
  if (error) throw error
  return data
}

export async function saveAdminControls({ hours, services }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_save_controls', {
    p_hours: hours,
    p_services: services,
  })
  if (error) throwQueueOperationError(error)
  return data
}

export async function fetchPublicQueue() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_public_queue')
  if (error) throw error
  return data ?? []
}

export async function fetchAdminQueue({ history = false } = {}) {
  const client = requireSupabase()
  let query = client
    .from('queue_entries')
    .select('id,client_id,service_id,service_name_snapshot,service_duration_minutes_snapshot,service_price_cents_snapshot,entry_type,status,position_order,deposit_cents,balance_paid_cents,balance_payment_method,remaining_minutes_override,created_at,started_at,completed_at,skipped_at,cancelled_at')
    .order('position_order', { ascending: true })
  query = history ? query.in('status', ['completed', 'skipped', 'cancelled']) : query.in('status', ['serving', 'waiting'])
  const { data: entries, error } = await query
  if (error) throw error
  if (!entries?.length) return []

  const clientIds = [...new Set(entries.map((entry) => entry.client_id))]
  const { data: clients, error: clientsError } = await client
    .from('clients')
    .select('id,name,phone')
    .in('id', clientIds)
  if (clientsError) throw clientsError
  const clientsById = new Map((clients ?? []).map((record) => [record.id, record]))
  return entries.map((entry) => ({ ...entry, client: clientsById.get(entry.client_id) ?? null }))
}

export async function fetchAdminPayments() {
  const client = requireSupabase()
  const { data, error } = await client
    .from('payment_transactions')
    .select('id,queue_entry_id,provider,provider_payment_id,amount_cents,status,created_at,paid_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function fetchAdminNotifications() {
  const client = requireSupabase()
  const { data, error } = await client
    .from('notifications')
    .select('id,queue_entry_id,channel,message,status,created_at,sent_at')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data ?? []
}

export async function addWalkIn({ name, phone, serviceId }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_add_walkin', {
    p_name: name,
    p_phone: phone,
    p_service_id: serviceId,
  })
  if (error) throwQueueOperationError(error)
  return data
}

export async function removeQueueEntry(queueEntryId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_remove_queue_entry', {
    p_queue_entry_id: queueEntryId,
  })
  if (error) throwQueueOperationError(error)
  return data
}

export async function finishCurrentService(expectedQueueEntryId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_finish_current_service', {
    p_expected_queue_entry_id: expectedQueueEntryId,
  })
  if (error) throwQueueOperationError(error)
  return data
}

export async function startNextService() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_start_next_service')
  if (error) throwQueueOperationError(error)
  return data
}

export async function createPixOrder(payload) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('create-pix-order', { body: payload })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

export async function fetchPixStatus({ requestId, checkoutToken }) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('get-pix-status', {
    body: { requestId, checkoutToken },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

export function subscribeToPublicQueue(onUpdate) {
  const client = requireSupabase()
  const channel = client
    .channel('public_queue')
    .on('broadcast', { event: 'queue_updated' }, onUpdate)
    .subscribe()
  return () => { void client.removeChannel(channel) }
}
