import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { ArrowLeft, Check, Clock3, Copy, Radio, Scissors, ShieldCheck, UserPlus, X } from 'lucide-react'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './auth/AuthProvider'
import { addWalkIn, createPixOrder, fetchActiveServices, fetchAdminControls, fetchAdminNotifications, fetchAdminPayments, fetchAdminQueue, fetchPixStatus, fetchPublicBusinessHours, fetchPublicQueue, finishCurrentService, removeQueueEntry, saveAdminControls, startNextService, subscribeToPublicQueue } from './lib/barberApi'

const services = [
  { name: 'Cabelo + barba + sobrancelha', duration: 35 },
  { name: 'Cabelo + barba', duration: 30 },
  { name: 'Cabelo', duration: 25 },
  { name: 'Pezinho', duration: 15 },
]
const businessDays = [
  { day_of_week: 1, name: 'Segunda-feira', is_open: false, opens_at: null, closes_at: null },
  { day_of_week: 2, name: 'Terça-feira', is_open: true, opens_at: '08:00', closes_at: '20:00' },
  { day_of_week: 3, name: 'Quarta-feira', is_open: true, opens_at: '08:00', closes_at: '20:00' },
  { day_of_week: 4, name: 'Quinta-feira', is_open: true, opens_at: '08:00', closes_at: '20:00' },
  { day_of_week: 5, name: 'Sexta-feira', is_open: true, opens_at: '08:00', closes_at: '20:00' },
  { day_of_week: 6, name: 'Sábado', is_open: true, opens_at: '08:00', closes_at: '20:00' },
  { day_of_week: 0, name: 'Domingo', is_open: true, opens_at: '08:00', closes_at: '13:00' },
]
const demoQueue = [
  { id: 1, name: 'João Silva', phone: '71999990001', service: services[1].name, duration: 30, source: 'Presencial', status: 'cutting', startedAt: Date.now() - 12 * 60 * 1000 },
  { id: 2, name: 'Carlos Souza', phone: '71999990002', service: 'Cabelo', duration: 25, source: 'Presencial', status: 'waiting' },
  { id: 3, name: 'Marcos Santos', phone: '71999990003', service: 'Pezinho', duration: 15, source: 'Online', status: 'waiting' },
  { id: 4, name: 'Rafael Lima', phone: '71999990004', service: services[0].name, duration: 35, source: 'Online', status: 'waiting' },
]
const samplePublicQueue = [
  { queue_entry_id: 'sample-serving', status: 'serving', display_name: 'João Silva', service_name: 'Cabelo + barba', started_at: Date.now() - 16 * 60000 },
  { queue_entry_id: 'sample-1', status: 'waiting', display_name: 'Carlos Souza', service_name: 'Cabelo', position: 1, people_ahead: 1, estimated_wait_minutes: 14 },
  { queue_entry_id: 'sample-2', status: 'waiting', display_name: 'Marcos Santos', service_name: 'Cabelo + barba + sobrancelha', position: 2, people_ahead: 2, estimated_wait_minutes: 39 },
  { queue_entry_id: 'sample-3', status: 'waiting', display_name: 'Rafael Lima', service_name: 'Pezinho', position: 3, people_ahead: 3, estimated_wait_minutes: 74 },
]
const createDemoHistory = () => {
  const names = ['Pedro Oliveira','Bruno Santos','Lucas Ferreira','Mateus Costa','Gabriel Almeida','Thiago Santos','André Lima','Felipe Rocha','Rafael Souza','Caio Martins','Diego Ribeiro','Vinícius Araújo','João Mendes','Marcos Carvalho','Eduardo Nunes','Renan Barros','Paulo Henrique','Igor Cardoso','Leandro Teixeira','Samuel Batista']
  return Array.from({ length: 100 }, (_, index) => {
    const completedAt = new Date()
    completedAt.setDate(completedAt.getDate() - ((index * 11) % 120))
    completedAt.setHours(8 + (index % 11), (index * 17) % 60, 0, 0)
    const service = services[index % services.length]
    return { id: `demo-history-${index + 1}`, name: names[index % names.length], service: service.name, date: completedAt.toLocaleString('pt-BR'), createdAt: completedAt.getTime(), amountCents: 1000 + ((index * 197) % 2001) }
  })
}
const demoHistory = createDemoHistory()
const QueueContext = createContext(null)
const useQueue = () => useContext(QueueContext)
const formatTime = (time) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(time))
function getWaitMinutes(queue, index, now = Date.now()) {
  if (index === 0) return 0
  const active = queue[0]
  const activeElapsed = active?.startedAt ? Math.floor((now - active.startedAt) / 60000) : 0
  const activeRemaining = active ? Math.max(0, active.duration - activeElapsed) : 0
  const waitingBefore = queue.slice(1, index).reduce((sum, person) => sum + person.duration, 0)
  return activeRemaining + waitingBefore
}
const formatWait = (minutes) => minutes <= 0 ? 'Sua vez' : `~ ${minutes} min`
const formatMoney = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const toDateInputValue = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
const monthStartValue = () => { const today = new Date(); return toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)) }

function Header() {
  return <header className="topbar"><Link to="/" className="brand"><span className="brand-icon"><Scissors size={17}/></span><span>SC <em>BARBER</em></span></Link><nav><NavLink to="/fila">Fila</NavLink><NavLink to="/entrar-na-fila">Entrar na fila</NavLink><NavLink to="/admin">Proprietário</NavLink></nav></header>
}

function AdminSubnav({ demo = false }) {
  const queuePath = demo ? '/demo/admin' : '/admin'
  const historyPath = demo ? '/demo/historico' : '/admin/historico'
  return <nav className="admin-subnav" aria-label="Navegação do proprietário"><NavLink to={queuePath} end>Fila</NavLink>{!demo&&<NavLink to="/admin/controle">Controle</NavLink>}<NavLink to={historyPath}>Histórico</NavLink></nav>
}

function BarberHero() {
  const [hours, setHours] = useState(businessDays.filter((day)=>[2,3,4,5,6,0].includes(day.day_of_week)))
  const [clock, setClock] = useState(()=>new Date())
  useEffect(() => {
    if (!isSupabaseConfigured) return undefined
    let active = true
    fetchPublicBusinessHours().then((savedHours)=>{
      if (active && savedHours.length) setHours(savedHours.map((day)=>({...day,name:businessDays.find((item)=>item.day_of_week===day.day_of_week)?.name??''})).filter((day)=>[2,3,4,5,6,0].includes(day.day_of_week)))
    }).catch(()=>{})
    return ()=>{active=false}
  }, [])
  useEffect(()=>{const timer=window.setInterval(()=>setClock(new Date()),30000);return()=>window.clearInterval(timer)},[])
  const today=clock.getDay()
  const minuteOfDay=clock.getHours()*60+clock.getMinutes()
  return <section className="barber-hero"><div className="hero-copy"><span className="hero-kicker"><i/> BARBEARIA · ESTILO · ATITUDE</span><h1>Seu próximo<br/><em>visual começa aqui.</em></h1><p>Corte no capricho, atendimento de verdade e seu lugar na fila pelo celular.</p><div className="hero-actions"><Link className="hero-cta" to="/fila"><Radio size={16}/> Acompanhar fila</Link><Link to="/entrar-na-fila" className="hero-secondary">Entrar na fila <span>↗</span></Link></div></div><div className="hero-logo-stage" aria-label="Logo SC Barber"><div className="hero-logo-emblem"><span className="hero-logo-scissors"><Scissors size={30}/></span><strong className="hero-logo-sc">SC</strong><strong className="hero-logo-barber">BARBER</strong><span className="hero-logo-rule"/><small>BARBEARIA · ESTILO</small></div><span className="hero-logo-caption">ESTILO EM CADA CORTE</span></div><div className="hours-card"><div className="hours-title"><Clock3 size={16}/><span><strong>HORÁRIOS</strong><small>Atendimento presencial</small></span></div><div className="hours-grid">{hours.map((day)=>{const isToday=day.day_of_week===today;const opens=day.opens_at?Number(day.opens_at.slice(0,2))*60+Number(day.opens_at.slice(3,5)):null;const closes=day.closes_at?Number(day.closes_at.slice(0,2))*60+Number(day.closes_at.slice(3,5)):null;const openNow=isToday&&day.is_open&&opens!==null&&closes!==null&&minuteOfDay>=opens&&minuteOfDay<closes;const todayStatus=openNow?'Aberto agora':day.is_open?'Fora do horário':'Fechado hoje';return <div className={`hours-day ${isToday?'is-today':''} ${openNow?'is-open-now':''}`} key={day.day_of_week}><strong>{day.name}</strong><span>{day.is_open?`${day.opens_at?.slice(0,5)} a ${day.closes_at?.slice(0,5)}`:'Fechado'}</span>{isToday&&<small className="hours-live-status"><i/>{todayStatus}</small>}</div>})}</div><div className="hours-note">Horários cadastrados pela barbearia.</div></div></section>
}
function LobbyPage() {
  return <main className="page home-page lobby-page"><BarberHero/></main>
}
function DemoLabel() { return <div className="demo-label">PRÉVIA VISUAL • DADOS FICTÍCIOS</div> }

function DemoQueuePage() {
  const { queue, notice, notifications } = useQueue()
  const active = queue.find((person) => person.status === 'cutting')
  const waiting = queue.filter((person) => person.status === 'waiting')
  return <main className="page home-page"><section className="queue-section" id="fila"><div className="section-heading"><span>ACOMPANHE EM TEMPO REAL</span><h2>Fila de hoje</h2><p>Veja quem está cortando e quanto falta para sua vez.</p></div><DemoLabel/><section className="panel queue-panel"><div className="panel-heading"><h1>Fila da Barbearia</h1><span className="live-badge"><Radio size={13}/> Demonstração</span></div>{active ? <div className="current-public"><span className="overline">AGORA CORTANDO</span><span className="current-start">Começou às {formatTime(active.startedAt)}</span><h2>{active.name}</h2><p>{active.service}</p></div> : <div className="empty-current"><span className="overline">EM ATENDIMENTO</span><h2>Nenhum atendimento iniciado</h2></div>}<div className="queue-list-heading"><h3>PRÓXIMOS DA FILA</h3><span>{waiting.length} aguardando</span></div><div className="public-list">{waiting.length ? waiting.map((person, index) => { const queueIndex = queue.indexOf(person); const ahead = queueIndex; const wait = getWaitMinutes(queue, queueIndex); return <div className={`public-row ${index === 0 ? 'next-up' : ''}`} key={person.id}><span className="public-position">{queueIndex + 1}</span><div className="public-person"><strong>{person.name}{index === 0 && <span className="next-tag">PRÓXIMO</span>}</strong><span>{person.service}</span></div><div className="public-ahead"><strong>{formatWait(wait)}</strong><span>estimativa</span><small>{ahead} {ahead === 1 ? 'pessoa' : 'pessoas'} na frente</small></div></div> }) : <div className="empty-list">Não há clientes aguardando.</div>}</div><div className="queue-explainer"><Clock3 size={14}/> Previsão aproximada calculada pela duração dos serviços.</div><Link to="/entrar-na-fila" className="primary-button">Entrar na fila</Link>{notice&&<div className="notice-bar"><Check size={15}/>{notice}</div>}{notifications.length>0&&<div className="notification-summary"><strong>🔔 Fila atualizada</strong><span>{notifications.length} notificações individuais simuladas após a última finalização.</span></div>}</section></section></main>
}

function LivePublicQueue() {
  const [queue, setQueue] = useState([])
  const [servicesList, setServicesList] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const [nextQueue, nextServices] = await Promise.all([fetchPublicQueue(), fetchActiveServices()])
        if (active) { setQueue(nextQueue); setServicesList(nextServices); setError('') }
      } catch (loadError) {
        if (active) setError(loadError.message || 'Não foi possível carregar a fila.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void refresh()
    const unsubscribe = subscribeToPublicQueue(() => { void refresh() })
    const interval = window.setInterval(() => { void refresh() }, 15000)
    return () => { active = false; unsubscribe(); window.clearInterval(interval) }
  }, [])
  const usingSample = !loading && queue.length === 0
  const isLive = !loading && !error && !usingSample
  const visibleQueue = usingSample ? samplePublicQueue : queue
  const current = visibleQueue.find((person) => person.status === 'serving')
  const waiting = visibleQueue.filter((person) => person.status === 'waiting')
  return <main className="page home-page"><section className="queue-section" id="fila"><div className="section-heading"><span>ACOMPANHE EM TEMPO REAL</span><h2>Fila de hoje</h2><p>Veja quem está cortando e quanto falta para sua vez.</p></div><section className="panel queue-panel"><div className="panel-heading"><h1>Fila da Barbearia</h1><span className={`live-badge ${isLive?'is-live':'offline-badge'} ${error?'is-error':''} ${usingSample?'is-sample':''} ${loading?'is-loading':''}`} role="status" aria-live="polite"><i className="live-indicator" aria-hidden="true"/>{error?'Conexão pendente':loading?'Conectando…':usingSample?'Exemplo fictício':'Ao vivo agora'}</span></div>{usingSample&&<div className="sample-queue-label">DADOS FICTÍCIOS · EXEMPLO DE VISUALIZAÇÃO</div>}{current?<div className="current-public"><span className="overline">AGORA CORTANDO</span>{current.started_at&&<span className="current-start">Começou às {formatTime(current.started_at)}</span>}<h2>{current.display_name}</h2><p>{current.service_name}</p></div>:<div className="empty-current"><span className="overline">EM ATENDIMENTO</span><h2>{loading?'Carregando fila…':'Nenhum atendimento iniciado'}</h2></div>}<div className="queue-list-heading"><h3>PRÓXIMOS DA FILA</h3><span>{waiting.length} aguardando</span></div><div className="public-list">{waiting.map((person,index)=><div className={`public-row ${index===0?'next-up':''}`} key={person.queue_entry_id}><span className="public-position">{person.position}</span><div className="public-person"><strong>{person.display_name}{index===0&&<span className="next-tag">PRÓXIMO</span>}</strong><span>{person.service_name}</span></div><div className="public-ahead"><strong>{formatWait(person.estimated_wait_minutes)}</strong><span>estimativa</span><small>{person.people_ahead} {person.people_ahead===1?'pessoa':'pessoas'} na frente</small></div></div>)}{!waiting.length&&!loading&&!error&&<div className="empty-list">Não há clientes aguardando.</div>}</div>{error&&<div className="setup-notice"><strong>Fila ainda não conectada ao banco</strong><span>{error}</span><span>A consulta pública usa a função segura <code>get_public_queue</code> para não expor telefones nem liberar leitura direta da tabela.</span></div>}<div className="queue-explainer"><Clock3 size={14}/> Atualização em tempo real e previsão aproximada de espera.</div><div className="service-strip"><strong>Serviços disponíveis</strong>{servicesList.length?servicesList.map((service)=><span key={service.id}>{service.name} · {service.duration_minutes} min</span>):<span>{isSupabaseConfigured?'Carregando serviços…':'Configure o Supabase para carregar os serviços.'}</span>}</div></section></section></main>
}

function QueuePage() {
  return isSupabaseConfigured ? <LivePublicQueue/> : <DemoQueuePage/>
}

function JoinQueue() {
  const { addCustomer } = useQueue()
  const [serviceOptions, setServiceOptions] = useState(services)
  const [selected, setSelected] = useState(services[1].name)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [payment, setPayment] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!isSupabaseConfigured) return undefined
    let active = true
    fetchActiveServices().then((items) => {
      if (!active) return
      const mapped = items.map((item)=>({ id:item.id, name:item.name, duration:item.duration_minutes, price_cents:item.price_cents }))
      setServiceOptions(mapped)
      setSelected(mapped[0]?.name ?? '')
    }).catch((loadError)=>{ if(active) setMessage(loadError.message) })
    return ()=>{ active=false }
  }, [])
  useEffect(() => {
    if (!payment?.requestId || !payment?.checkoutToken || payment.status === 'paid') return undefined
    let active = true
    const check = async () => {
      try {
        const result = await fetchPixStatus({ requestId: payment.requestId, checkoutToken: payment.checkoutToken })
        if (!active) return
        if (result.status === 'paid' || result.queueStatus === 'waiting') {
          setPayment((current) => current ? { ...current, status: 'paid' } : current)
          setPaymentStatus('Pagamento confirmado! Você já está na fila. A posição será exibida na tela pública.')
          void fetchPublicQueue()
        } else if (result.status === 'failed' || result.status === 'refunded' || result.queueStatus === 'cancelled') {
          setPayment((current) => current ? { ...current, status: result.status } : current)
          setPaymentStatus('Este pagamento não foi aprovado. A entrada não foi liberada na fila.')
        }
      } catch {
        // Keep showing the last known state; the webhook and next poll can recover.
      }
    }
    void check()
    const timer = window.setInterval(() => { void check() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [payment?.requestId, payment?.checkoutToken, payment?.status])
  const join = async (event) => {
    event.preventDefault()
    setMessage('')
    if (!name.trim() || !phone.trim() || !email.trim()) { setMessage('Preencha nome, telefone e e-mail.'); return }
    if (!isSupabaseConfigured) {
      addCustomer({ name: name.trim(), phone: phone.replace(/\D/g, ''), service: selected, source: 'Online' })
      setMessage('Demonstração: nenhuma cobrança foi realizada. Sua posição foi adicionada à prévia.')
      return
    }
    const service = serviceOptions.find((item) => item.name === selected)
    if (!service?.id) { setMessage('Selecione um serviço ativo para continuar.'); return }
    setSubmitting(true)
    try {
      const requestKey = 'barber-pix-checkout-v1'
      const checkoutData = {
        name: name.trim(),
        phone: phone.replace(/\D/g, ''),
        email: email.trim().toLowerCase(),
        serviceId: service.id,
      }
      const serializedData = JSON.stringify(checkoutData)
      const savedData = sessionStorage.getItem(`${requestKey}-data`)
      const savedRequestId = sessionStorage.getItem(`${requestKey}-request`)
      const savedToken = sessionStorage.getItem(`${requestKey}-token`)

      let requestId
      let checkoutToken
      if (savedData === serializedData && savedRequestId && savedToken) {
        requestId = savedRequestId
        checkoutToken = savedToken
      } else {
        requestId = crypto.randomUUID()
        checkoutToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
        sessionStorage.setItem(`${requestKey}-data`, serializedData)
        sessionStorage.setItem(`${requestKey}-request`, requestId)
        sessionStorage.setItem(`${requestKey}-token`, checkoutToken)
      }
      const result = await createPixOrder({
        ...checkoutData, requestId, checkoutToken,
      })
      setPayment({ ...result, requestId, checkoutToken })
      setPaymentStatus(result.status === 'processed' ? 'Aguardando confirmação segura do pagamento…' : 'Pix criado. A vaga entra na fila somente após confirmação do pagamento.')
    } catch (error) {
      setMessage(error.message || 'Não foi possível preparar o Pix. Tente novamente; a solicitação será reutilizada para evitar duplicidade.')
    } finally {
      setSubmitting(false)
    }
  }
  const copyPixCode = async () => {
    if (!payment?.qrCode) return
    await navigator.clipboard.writeText(payment.qrCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }
  const startFreshPix = () => {
    sessionStorage.removeItem('barber-pix-checkout-v1-request')
    sessionStorage.removeItem('barber-pix-checkout-v1-token')
    sessionStorage.removeItem('barber-pix-checkout-v1-data')
    setPayment(null)
    setPaymentStatus('Você pode iniciar uma nova solicitação de pagamento.')
  }
  return <main className="page narrow-page join-page"><section className="panel form-panel"><Link to="/" className="back-link"><ArrowLeft size={15}/> Voltar para a fila</Link><h1>Entre na fila de casa</h1><p className="intro">Preencha seus dados e escolha o serviço.</p><form onSubmit={join}><label className="field-label">Nome<input value={name} onChange={(event)=>setName(event.target.value)} placeholder="Seu nome" required /></label><label className="field-label">Telefone<input value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="(71) 99999-9999" inputMode="tel" required /></label><label className="field-label">E-mail<input type="email" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="voce@email.com" autoComplete="email" required /></label><label className="field-label">Serviço<select value={selected} onChange={(event)=>setSelected(event.target.value)} required>{serviceOptions.map((service)=><option key={service.id??service.name} value={service.name}>{service.name} · {service.duration} min{service.price_cents!=null?` · ${formatMoney(service.price_cents)}`:''}</option>)}</select></label><div className="entry-fee"><span>Entrada online</span><strong>R$ 10,00</strong><small>Será descontada do valor final. {isSupabaseConfigured?'A vaga só será criada após confirmação do pagamento.':'Na prévia, nenhum pagamento é processado.'}</small></div><button type="submit" className="primary-button" disabled={submitting||payment?.status==='paid'}>{submitting?'Preparando Pix…':isSupabaseConfigured?'Gerar Pix':'Simular entrada na fila'}</button></form>{message&&<div className="form-message">{message}</div>}{payment&&<section className="pix-payment" aria-live="polite"><h2>Pagamento Pix</h2><p>{paymentStatus}</p>{payment.status!=='paid'&&payment.status!=='failed'&&payment.status!=='refunded'&&<><strong className="pix-amount">R$ 10,00</strong>{payment.qrCodeBase64&&<img className="pix-qr" src={`data:image/png;base64,${payment.qrCodeBase64}`} alt="QR Code Pix"/>}{payment.qrCode&&<div className="pix-copy"><label htmlFor="pix-copy-code">Pix copia e cola</label><textarea id="pix-copy-code" value={payment.qrCode} readOnly/><button type="button" className="secondary-button" onClick={copyPixCode}><Copy size={14}/>{copied?'Copiado':'Copiar código Pix'}</button></div>}{payment.ticketUrl&&<a className="pix-ticket" href={payment.ticketUrl} target="_blank" rel="noreferrer">Abrir pagamento no Mercado Pago</a>}</>}{(payment.status==='failed'||payment.status==='refunded')&&<button type="button" className="secondary-button" onClick={startFreshPix}>Iniciar novo Pix</button>}</section>}</section></main>
}

function OwnerLogin({ accessMessage = '' }) {
  const { configured, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(accessMessage)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try { await signIn(email, password) }
    catch (authError) {
      const message = String(authError?.message ?? '').toLowerCase()
      if (message.includes('invalid login credentials')) setError('E-mail ou senha incorretos. Confira os dados e tente novamente.')
      else if (message.includes('não está autorizada') || message.includes('not authorized')) setError('Esta conta não está autorizada como proprietária. Peça ao proprietário para conferir o cadastro em admin_users.')
      else if (message.includes('permission denied') || message.includes('row-level security') || message.includes('42501')) setError('Acesso negado ao validar a autorização. Confira se esta conta está cadastrada em admin_users.')
      else if (message.includes('fetch') || message.includes('network')) setError('Não foi possível conectar ao Supabase. Confira a conexão e tente novamente.')
      else setError('Não foi possível validar o acesso. Confira a conexão e tente novamente.')
    }
    finally { setSubmitting(false) }
  }
  return <main className="page narrow-page"><section className="panel form-panel owner-panel"><div className="owner-icon"><ShieldCheck size={22}/></div><h1>Acesso do proprietário</h1><p className="intro">Entre com o usuário autorizado em <code>public.admin_users</code>.</p><form onSubmit={submit}><label className="field-label">E-mail<input type="email" autoComplete="username" value={email} onChange={(event)=>setEmail(event.target.value)} placeholder="E-mail do proprietário" required /></label><label className="field-label">Senha<input type="password" autoComplete="current-password" value={password} onChange={(event)=>setPassword(event.target.value)} placeholder="Sua senha" required /></label><button type="submit" className="primary-button" disabled={!configured || submitting}>{submitting?'Entrando…':'Entrar'}</button></form>{error&&<div className="form-message auth-error">{error}</div>}{!configured&&<div className="setup-notice"><strong>Conexão ainda não configurada</strong><span>Crie <code>.env.local</code> na raiz do projeto com <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_KEY</code> (ou <code>VITE_SUPABASE_ANON_KEY</code>). Use a chave pública (anon/publishable); nunca coloque a service_role no frontend.</span></div>}<Link to="/demo/admin" className="demo-link">Abrir prévia demonstrativa do painel</Link></section></main>
}

function AdminArea({ history = false, control = false }) {
  const { user, isAdmin, loading, signOut } = useAuth()
  const [error, setError] = useState('')
  if (loading) return <main className="page"><p className="help-text">Verificando acesso do proprietário…</p></main>
  if (!user || !isAdmin) return <OwnerLogin accessMessage={user ? 'Esta conta autenticada não está autorizada como proprietária. Entre com uma conta cadastrada em admin_users.' : ''} />
  const logout = async () => { try { await signOut() } catch (logoutError) { setError(logoutError.message) } }
  if (control) return <AdminControlsPage email={user.email} onSignOut={logout} signOutError={error}/>
  return <LiveAdminDashboard history={history} email={user.email} onSignOut={logout} signOutError={error}/>
}

function AdminControlsPage({ email, onSignOut, signOutError }) {
  const [hours, setHours] = useState(businessDays)
  const [serviceItems, setServiceItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    fetchAdminControls().then((result)=>{
      if (!active) return
      const savedHours = new Map((result?.hours ?? []).map((day)=>[Number(day.day_of_week),day]))
      setHours(businessDays.map((day)=>({...day,...(savedHours.get(day.day_of_week) ?? {})})))
      setServiceItems((result?.services ?? []).map((service)=>({...service,price_value:((service.price_cents??0)/100).toFixed(2)})))
    }).catch((loadError)=>{if(active)setError(loadError.message||'Não foi possível carregar as configurações.')})
      .finally(()=>{if(active)setLoading(false)})
    return ()=>{active=false}
  }, [])

  const updateDay = (dayNumber, changes) => setHours((current)=>current.map((day)=>day.day_of_week===dayNumber?{...day,...changes}:day))
  const updateService = (serviceId, changes) => setServiceItems((current)=>current.map((service)=>service.id===serviceId?{...service,...changes}:service))
  const save = async (event) => {
    event.preventDefault(); setError(''); setNotice('')
    if (hours.some((day)=>day.is_open&&(!day.opens_at||!day.closes_at||day.opens_at>=day.closes_at))) { setError('Confira os horários: o fechamento precisa ser depois da abertura.'); return }
    if (serviceItems.some((service)=>!service.name.trim()||Number(service.duration_minutes)<5||Number(service.duration_minutes)>240||!Number.isFinite(Number(service.price_value))||Number(service.price_value)<0)) { setError('Confira os nomes, durações e preços dos serviços.'); return }
    setSaving(true)
    try {
      await saveAdminControls({
        hours: hours.map(({day_of_week,is_open,opens_at,closes_at})=>({day_of_week,is_open,opens_at:is_open?opens_at:null,closes_at:is_open?closes_at:null})),
        services: serviceItems.map(({id,name,duration_minutes,price_value,active})=>({id,name:name.trim(),duration_minutes:Number(duration_minutes),price_cents:Math.round(Number(price_value)*100),active})),
      })
      setNotice('Configurações salvas. A fila pública e as novas entradas já usam esses dados.')
    } catch (saveError) { setError(saveError.message||'Não foi possível salvar as configurações.') }
    finally { setSaving(false) }
  }

  return <main className="page control-page"><AdminSubnav/><div className="admin-heading"><div><span className="overline">ÁREA DO PROPRIETÁRIO · {email}</span><h1>Controle da barbearia</h1><p className="intro">Ajuste os horários, serviços e tempos usados nas estimativas da fila.</p></div><button type="button" className="secondary-button signout-button" onClick={onSignOut}>Sair</button></div>{signOutError&&<div className="auth-error form-message">{signOutError}</div>}{error&&<div className="auth-error form-message">{error}</div>}{notice&&<div className="notice-bar"><Check size={15}/>{notice}</div>}{loading?<section className="panel control-panel"><p className="help-text">Carregando configurações…</p></section>:<form className="control-layout" onSubmit={save}><section className="panel control-panel"><div className="control-section-heading"><div><span className="overline">EXPEDIENTE</span><h2>Horários de atendimento</h2></div><p>Escolha os dias abertos e defina os horários.</p></div><div className="control-hours-grid">{hours.map((day)=><div className="control-day-card" key={day.day_of_week}><label className="control-day-toggle"><input type="checkbox" checked={Boolean(day.is_open)} onChange={(event)=>updateDay(day.day_of_week,{is_open:event.target.checked,opens_at:event.target.checked?(day.opens_at||'08:00'):null,closes_at:event.target.checked?(day.closes_at||(day.day_of_week===0?'13:00':'20:00')):null})}/><strong>{day.name}</strong><span>{day.is_open?'Aberto':'Fechado'}</span></label>{day.is_open&&<div className="control-time-fields"><label>Abre<input type="time" value={day.opens_at??'08:00'} onChange={(event)=>updateDay(day.day_of_week,{opens_at:event.target.value})}/></label><label>Fecha<input type="time" value={day.closes_at??'20:00'} onChange={(event)=>updateDay(day.day_of_week,{closes_at:event.target.value})}/></label></div>}</div>)}</div></section><section className="panel control-panel"><div className="control-section-heading"><div><span className="overline">CATÁLOGO</span><h2>Serviços e duração</h2></div><p>A duração define a estimativa para quem está aguardando.</p></div><div className="control-service-list">{serviceItems.map((service)=><article className={`control-service-card ${!service.active?'service-disabled':''}`} key={service.id}><label className="control-service-name">Nome do serviço<input value={service.name} maxLength={80} onChange={(event)=>updateService(service.id,{name:event.target.value})}/></label><div className="control-service-fields"><label>Duração (min)<input type="number" min="5" max="240" step="5" value={service.duration_minutes} onChange={(event)=>updateService(service.id,{duration_minutes:event.target.value})}/></label><label>Preço (R$)<input type="number" min="0" max="20000" step="0.50" value={service.price_value} onChange={(event)=>updateService(service.id,{price_value:event.target.value})}/></label><label className="control-active-toggle"><input type="checkbox" checked={Boolean(service.active)} onChange={(event)=>updateService(service.id,{active:event.target.checked})}/> Disponível na fila</label></div></article>)}{!serviceItems.length&&<p className="empty-list">Nenhum serviço cadastrado.</p>}</div><p className="control-note">Ao salvar, o novo tempo e nome também atualizam quem ainda está aguardando. Atendimentos em andamento e o histórico permanecem como foram registrados.</p><button className="primary-button control-save" type="submit" disabled={saving||serviceItems.length===0}>{saving?'Salvando…':'Salvar controles'}</button></section></form>}</main>
}

function LiveWalkInForm({ servicesList, onAdded }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [serviceId, setServiceId] = useState(servicesList[0]?.id ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!servicesList.some((service)=>service.id===serviceId)) setServiceId(servicesList[0]?.id ?? '') }, [servicesList,serviceId])
  const submit = async (event) => {
    event.preventDefault(); setError(''); setSaving(true)
    try { await addWalkIn({ name, phone, serviceId }); setName(''); setPhone(''); await onAdded() }
    catch (saveError) { setError(saveError.message || 'Não foi possível adicionar à fila.') }
    finally { setSaving(false) }
  }
  return <form className="walkin-form" onSubmit={submit}><h2><UserPlus size={17}/> Adicionar à fila</h2><label className="field-label">Nome<input value={name} onChange={(event)=>setName(event.target.value)} required /></label><label className="field-label">Telefone<input value={phone} onChange={(event)=>setPhone(event.target.value)} inputMode="tel" required /></label><label className="field-label">Serviço<select value={serviceId} onChange={(event)=>setServiceId(event.target.value)} required>{servicesList.map((service)=><option key={service.id} value={service.id}>{service.name} · {service.duration_minutes} min</option>)}</select></label><div className="walkin-free">Entrada presencial <strong>R$ 0,00</strong></div><button className="primary-button" type="submit" disabled={!serviceId||saving}>{saving?'Adicionando…':'Adicionar'}</button>{error&&<p className="auth-error form-message">{error}</p>}</form>
}

function ConfirmActionButton({ className, disabled, title, message, confirmLabel, onConfirm, children }) {
  const [open, setOpen] = useState(false)
  const titleId = useId()

  useEffect(() => {
    if (!open) return undefined
    const dismissOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', dismissOnEscape)
    return () => window.removeEventListener('keydown', dismissOnEscape)
  }, [open])

  return <>
    <button className={className} type="button" disabled={disabled} onClick={() => setOpen(true)}>{children}</button>
    {open && <div className="confirmation-backdrop"><section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>{message}</p>
      <div className="confirmation-actions">
        <button className="secondary-button" type="button" onClick={() => setOpen(false)}>Cancelar</button>
        <button className="primary-button" type="button" onClick={() => { setOpen(false); onConfirm() }}>{confirmLabel}</button>
      </div>
    </section></div>}
  </>
}

function LiveAdminDashboard({ history, email, onSignOut, signOutError }) {
  const [queue, setQueue] = useState([])
  const [servicesList, setServicesList] = useState([])
  const [notifications, setNotifications] = useState([])
  const [payments, setPayments] = useState([])
  const [serviceFilter, setServiceFilter] = useState('')
  const [period, setPeriod] = useState('Mês')
  const [dateFrom, setDateFrom] = useState(monthStartValue)
  const [dateTo, setDateTo] = useState(() => toDateInputValue(new Date()))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    try {
      const [entries, activeServices, latestNotifications, latestPayments] = await Promise.all([
        fetchAdminQueue({ history }), fetchActiveServices(), fetchAdminNotifications(), fetchAdminPayments(),
      ])
      setQueue(entries); setServicesList(activeServices); setNotifications(latestNotifications); setPayments(latestPayments); setError('')
    } catch (loadError) { setError(loadError.message || 'Não foi possível consultar o Supabase.') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [entries, activeServices, latestNotifications, latestPayments] = await Promise.all([
          fetchAdminQueue({ history }), fetchActiveServices(), fetchAdminNotifications(), fetchAdminPayments(),
        ])
        if (active) { setQueue(entries); setServicesList(activeServices); setNotifications(latestNotifications); setPayments(latestPayments); setError('') }
      } catch (loadError) { if (active) setError(loadError.message || 'Não foi possível consultar o Supabase.') }
      finally { if (active) setLoading(false) }
    }
    void load()
    const unsubscribe = subscribeToPublicQueue(() => { void load() })
    const interval = window.setInterval(() => { void load() }, 20000)
    return () => { active = false; unsubscribe(); window.clearInterval(interval) }
  }, [history])
  const active = queue.find((entry)=>entry.status==='serving')
  const waiting = queue.filter((entry)=>entry.status==='waiting')
  const perform = async (operation) => {
    setBusy(true); setError('')
    try { await operation(); await refresh() }
    catch (actionError) { setError(actionError.message || 'Não foi possível concluir a operação.') }
    finally { setBusy(false) }
  }
  if (history) {
    const today = new Date()
    const filtered = queue.filter((entry)=>{
      const matchesService = !serviceFilter || entry.service_id===serviceFilter
      const date = new Date(entry.completed_at || entry.created_at)
      const dateValue = toDateInputValue(date)
      const matchesPeriod = period==='Intervalo' ? dateFrom<=dateTo&&dateValue>=dateFrom&&dateValue<=dateTo : period==='Dia' ? date.toDateString()===today.toDateString() : period==='Mês' ? date.getMonth()===today.getMonth()&&date.getFullYear()===today.getFullYear() : date.getFullYear()===today.getFullYear()
      return matchesService&&matchesPeriod
    })
    const completed = filtered.filter((entry)=>entry.status==='completed')
    const serviceTotal = completed.reduce((sum,entry)=>sum+(entry.service_price_cents_snapshot||0),0)
    const filteredEntryIds = new Set(filtered.map((entry)=>entry.id))
    const paidDeposits = payments.filter((payment)=>payment.status==='paid'&&filteredEntryIds.has(payment.queue_entry_id)).reduce((sum,payment)=>sum+payment.amount_cents,0)
    return <main className="page"><AdminSubnav/><div className="admin-heading"><div><span className="overline">ÁREA DO PROPRIETÁRIO · {email}</span><h1>Histórico de atendimentos</h1></div><div className="history-heading-actions"><Link to="/demo/historico" className="secondary-button">Prévia fictícia · 100 registros</Link><button type="button" className="secondary-button signout-button" onClick={onSignOut}>Sair</button></div></div>{error&&<div className="auth-error form-message">{error}</div>}<section className="panel history-panel"><div className="period-tabs" role="tablist" aria-label="Período do histórico">{['Dia','Mês','Ano','Intervalo'].map(item=><button type="button" role="tab" aria-selected={period===item} className={period===item?'active':''} key={item} onClick={()=>setPeriod(item)}>{item}</button>)}</div><div className="date-range-picker"><label>De<input type="date" value={dateFrom} onChange={(event)=>{setDateFrom(event.target.value);setPeriod('Intervalo')}}/></label><span>até</span><label>Até<input type="date" value={dateTo} onChange={(event)=>{setDateTo(event.target.value);setPeriod('Intervalo')}}/></label></div><label className="field-label">Filtrar por serviço<select value={serviceFilter} onChange={(event)=>setServiceFilter(event.target.value)}><option value="">Todos os serviços</option>{servicesList.map((service)=><option key={service.id} value={service.id}>{service.name}</option>)}</select></label><div className="history-stats"><div><span>Cortes realizados</span><strong>{loading?'…':completed.length}</strong><small>Atendimentos concluídos ({period.toLowerCase()})</small></div><div><span>Valor dos serviços</span><strong>{loading?'…':formatMoney(serviceTotal)}</strong><small>Entradas Pix pagas: {formatMoney(paidDeposits)}</small></div></div><div className="history-table"><div className="history-table-head"><span>CLIENTE</span><span>SERVIÇO</span><span>DATA</span></div>{filtered.map((entry)=><div className="history-row" key={entry.id}><strong>{entry.client?.name??'Cliente'}</strong><span>{entry.service_name_snapshot}</span><span>{entry.completed_at?new Date(entry.completed_at).toLocaleString('pt-BR'):'—'}</span></div>)}{!loading&&!filtered.length&&<p className="empty-list">Nenhum atendimento neste período.</p>}</div></section>{signOutError&&<p className="auth-error">{signOutError}</p>}</main>
  }
  return <main className="page"><AdminSubnav/><div className="admin-heading"><div><span className="overline">ÁREA DO PROPRIETÁRIO · {email}</span><h1>Fila de hoje</h1></div><div className="admin-heading-actions"><span className="connection connected"><i/>Supabase conectado</span><button type="button" className="secondary-button signout-button" onClick={onSignOut}>Sair</button></div></div>{error&&<div className="auth-error form-message">{error}</div>}<div className="admin-layout"><section className="panel admin-panel"><div className="current-service admin-current">{loading?<><span className="overline">FILA</span><h2>Carregando dados…</h2></>:active?<><span className="overline">EM ATENDIMENTO</span><span className="state-pill">Cortando</span><h2>{active.client?.name}</h2><p>{active.service_name_snapshot} · {active.service_duration_minutes_snapshot} min</p><small className="started-at">{active.started_at?`Começou às ${formatTime(active.started_at)}`:'Horário de início pendente'}</small></>:<><span className="overline">EM ATENDIMENTO</span><h2>Nenhum atendimento iniciado</h2></>}</div><div className={`next-service ${waiting[0]?'admin-next':''}`}><span className="overline">PRÓXIMO DA FILA</span>{waiting[0]?<><h2>{waiting[0].client?.name}</h2><p>{waiting[0].service_name_snapshot} · posição {active?2:1} · {active?'1 pessoa':'0 pessoas'} na frente</p></>:<><h2>Nenhum cliente aguardando</h2><p>Os novos clientes aparecerão aqui.</p></>}</div><div className="admin-queue"><div className="queue-list-heading"><h3>CLIENTES NA FILA</h3><span>{waiting.length} aguardando</span></div>{waiting.map((entry,index)=>{const peopleAhead=index+(active?1:0);return <div className={`admin-person-row ${index===0?'admin-next-row':''}`} key={entry.id}><div className="admin-person-main"><span className="admin-position">{index+(active?2:1)}</span><div><strong>{entry.client?.name}</strong><span>{entry.service_name_snapshot} · {entry.entry_type==='in_person'?'Presencial':'Online'}</span><small>Telefone: {entry.client?.phone} · {peopleAhead} {peopleAhead===1?'pessoa':'pessoas'} na frente</small></div></div><ConfirmActionButton className="remove-button" disabled={busy} title="Remover cliente da fila?" message={`${entry.client?.name??'Este cliente'} será marcado como cancelado e sairá da fila.`} confirmLabel="Remover cliente" onConfirm={()=>void perform(()=>removeQueueEntry(entry.id))}><X size={15}/><span>Remover</span></ConfirmActionButton></div>})}{!waiting.length&&!loading&&<p className="empty-list">A fila está vazia.</p>}</div><div className="admin-actions"><button className="primary-button" disabled={loading||busy||Boolean(active)||waiting.length===0} onClick={()=>void perform(startNextService)}>{busy?'Atualizando…':'Iniciar atendimento'}</button><ConfirmActionButton className="primary-button" disabled={!active||busy} title="Finalizar corte?" message={waiting[0]?`O corte de ${active?.client?.name??'cliente atual'} será finalizado e ${waiting[0]?.client?.name} será chamado para o próximo atendimento.`:`O corte de ${active?.client?.name??'cliente atual'} será finalizado. Não há outro cliente aguardando.`} confirmLabel="Finalizar corte" onConfirm={()=>void perform(()=>finishCurrentService(active.id))}>{busy?'Atualizando…':'Finalizar corte e chamar próximo'}</ConfirmActionButton></div><div className="notification-log"><h3>NOTIFICAÇÕES RECENTES</h3>{notifications.slice(0,5).map((item)=><div className="notification-row" key={item.id}><span>{item.status==='sent'?'Enviada':item.status==='failed'?'Falhou':'Pendente'} · {item.channel}</span><p>{item.message}</p></div>)}{!notifications.length&&<p className="empty-list">Nenhuma notificação registrada.</p>}</div></section><aside className="panel admin-side"><LiveWalkInForm servicesList={servicesList} onAdded={refresh}/><div className="demo-note">Cadastro presencial gratuito. A confirmação de pagamento online será processada pelo backend.</div></aside></div>{signOutError&&<p className="auth-error">{signOutError}</p>}</main>
}

function AddWalkIn({ onAdd }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [service, setService] = useState(services[2].name)
  const submit = (event) => {
    event.preventDefault()
    if (!name.trim() || !phone.trim()) return
    onAdd({ name: name.trim(), phone: phone.replace(/\D/g, ''), service, source: 'Presencial' })
    setName(''); setPhone('')
  }
  return <form className="walkin-form" onSubmit={submit}><h2><UserPlus size={17}/> Adicionar à fila</h2><label className="field-label">Nome<input value={name} onChange={(event)=>setName(event.target.value)} placeholder="Nome do cliente" required /></label><label className="field-label">Telefone<input value={phone} onChange={(event)=>setPhone(event.target.value)} placeholder="(71) 99999-9999" inputMode="tel" required /></label><label className="field-label">Serviço<select value={service} onChange={(event)=>setService(event.target.value)}>{services.map((item)=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label><div className="walkin-free">Entrada presencial <strong>R$ 0,00</strong></div><button className="primary-button" type="submit">Adicionar</button></form>
}

function AdminDemo() {
  const { queue, finishCurrent, removeCustomer, addCustomer, completed, notice, notifications } = useQueue()
  const active = queue.find((person)=>person.status==='cutting')
  const waiting = queue.filter((person)=>person.status==='waiting')
  const next = waiting[0]
  return <main className="page"><DemoLabel/><AdminSubnav demo/><div className="admin-heading"><div><span className="overline">PAINEL DO BARBEIRO • DEMONSTRAÇÃO</span><h1>Fila de hoje</h1></div><Link to="/admin" className="back-link"><ShieldCheck size={15}/> Acesso proprietário</Link></div><div className="admin-layout"><section className="panel admin-panel"><div className="current-service admin-current"><span className="overline">EM ATENDIMENTO</span><span className="state-pill">{active?'Cortando':'Parado'}</span>{active?<><h2>{active.name}</h2><p>{active.service} · {active.duration} min</p><small className="started-at">Começou às {formatTime(active.startedAt)}</small></>:<><h2>Nenhum atendimento iniciado</h2><p>Não há cliente sendo atendido agora.</p></>}</div><div className={`next-service ${next?'admin-next':''}`}><span className="overline">PRÓXIMO DA FILA</span>{next?<><h2>{next.name}</h2><p>{next.service} · Posição 2 · 1 pessoa na frente</p></>:<><h2>Nenhum cliente aguardando</h2><p>Adicione alguém para continuar a demonstração.</p></>}</div><div className="admin-queue"><div className="queue-list-heading"><h3>CLIENTES NA FILA</h3><span>{waiting.length} aguardando</span></div>{waiting.map((person,index)=><div className={`admin-person-row ${index===0?'admin-next-row':''}`} key={person.id}><div className="admin-person-main"><span className="admin-position">{index+2}</span><div><strong>{person.name}{index===0&&<span className="next-tag">PRÓXIMO</span>}</strong><span>{person.service} · Entrada {person.source.toLowerCase()}</span><small>{index+1} {index===0?'pessoa':'pessoas'} na frente · {formatWait(getWaitMinutes(queue,queue.indexOf(person)))}</small></div></div><div className="row-actions"><button className="whatsapp-button" type="button" title="WhatsApp será conectado na próxima etapa">WhatsApp</button><ConfirmActionButton className="remove-button" title="Remover cliente da fila?" message={`Confirme a remoção de ${person.name} da fila.`} confirmLabel="Confirmar remoção" onConfirm={()=>removeCustomer(person.id)}><X size={15}/><span>Remover</span></ConfirmActionButton></div></div>)}{waiting.length===0&&<p className="empty-list">A fila está vazia.</p>}</div><div className="admin-actions"><ConfirmActionButton className="primary-button" disabled={!active} title="Finalizar corte?" message={next?`Finalizar o corte de ${active.name} e chamar ${next.name} para o próximo atendimento?`:`Finalizar o corte de ${active.name}? Não há próximo cliente na fila.`} confirmLabel="Confirmar finalização" onConfirm={finishCurrent}>Finalizar corte e chamar próximo</ConfirmActionButton></div>{notice&&<div className="notice-bar admin-notice"><Check size={15}/>{notice}</div>}{notifications.length>0&&<div className="notification-log"><h3>NOTIFICAÇÕES DA ÚLTIMA FINALIZAÇÃO</h3>{notifications.map((item)=><div className="notification-row" key={item.id}><span>{item.name}</span><p>{item.message}</p></div>)}</div>}</section><aside className="panel admin-side"><AddWalkIn onAdd={addCustomer}/><div className="demo-note">Nesta prévia, os dados ficam apenas no navegador. O painel real exigirá login do proprietário.</div></aside></div></main>
}

function HistoryPage() {
  const { completed } = useQueue()
  const [period, setPeriod] = useState('Mês')
  const [dateFrom, setDateFrom] = useState(monthStartValue)
  const [dateTo, setDateTo] = useState(() => toDateInputValue(new Date()))
  const [service, setService] = useState('')
  const today = new Date()
  const filtered = completed.filter((item)=>{
    const date = new Date(item.createdAt || Date.now())
    const dateValue = toDateInputValue(date)
    const matchesPeriod = period==='Intervalo' ? dateFrom<=dateTo&&dateValue>=dateFrom&&dateValue<=dateTo : period==='Dia' ? date.toDateString()===today.toDateString() : period==='Mês' ? date.getMonth()===today.getMonth()&&date.getFullYear()===today.getFullYear() : date.getFullYear()===today.getFullYear()
    return (!service||item.service===service)&&matchesPeriod
  })
  const totalAmount = filtered.reduce((sum,item)=>sum+(item.amountCents||0),0)
  return <main className="page"><DemoLabel/><AdminSubnav demo/><div className="admin-heading"><div><span className="overline">PAINEL DO BARBEIRO • DEMONSTRAÇÃO</span><h1>Histórico de atendimentos</h1></div><Link to="/demo/admin" className="back-link"><ArrowLeft size={15}/> Voltar</Link></div><section className="panel history-panel"><div className="period-tabs" role="tablist" aria-label="Período do histórico">{['Dia','Mês','Ano','Intervalo'].map(item=><button type="button" role="tab" aria-selected={period===item} className={period===item?'active':''} key={item} onClick={()=>setPeriod(item)}>{item}</button>)}</div><div className="date-range-picker"><label>De<input type="date" value={dateFrom} onChange={(event)=>{setDateFrom(event.target.value);setPeriod('Intervalo')}}/></label><span>até</span><label>Até<input type="date" value={dateTo} onChange={(event)=>{setDateTo(event.target.value);setPeriod('Intervalo')}}/></label></div><label className="field-label">Filtrar por serviço<select value={service} onChange={(event)=>setService(event.target.value)}><option value="">Todos os serviços</option>{services.map(item=><option key={item.name}>{item.name}</option>)}</select></label><div className="history-stats"><div><span>Cortes realizados</span><strong>{filtered.length}</strong><small>Atendimentos concluídos ({period.toLowerCase()})</small></div><div><span>Valor dos serviços</span><strong>{formatMoney(totalAmount)}</strong><small>Total dos valores fictícios exibidos</small></div></div><div className="history-table demo-history-table"><div className="history-table-head"><span>CLIENTE</span><span>SERVIÇO</span><span>DATA</span><span>VALOR</span></div>{filtered.map(item=><div className="history-row" key={item.id}><strong>{item.name}</strong><span>{item.service}</span><span>{item.date}</span><strong>{formatMoney(item.amountCents||0)}</strong></div>)}{filtered.length===0&&<p className="empty-list">Nenhum atendimento neste filtro.</p>}</div><div className="history-empty">Dados fictícios para visualização. São registros de demonstração, sem relação com atendimentos reais.</div></section></main>
}

export default function App() {
  const [queue, setQueue] = useState(demoQueue)
  const [completed, setCompleted] = useState(demoHistory)
  const [notifications, setNotifications] = useState([])
  const [notice, setNotice] = useState('')
  const addCustomer = (customer) => {
    const service = services.find((item)=>item.name===customer.service) || services[2]
    setQueue((items)=>[...items,{...customer,id:Date.now(),duration:service.duration,status:'waiting'}])
    setNotice(`${customer.name} entrou na fila de demonstração.`)
    window.setTimeout(()=>setNotice(''),3500)
  }
  const removeCustomer = (customerId) => {
    const removed = queue.find((person)=>person.id===customerId)
    setQueue((items)=>items.filter((person)=>person.id!==customerId))
    if(removed) {
      setNotice(`${removed.name} foi removido da fila. As posições foram recalculadas.`)
      window.setTimeout(()=>setNotice(''),3500)
    }
  }
  const finishCurrent = () => {
    const current=queue.find((person)=>person.status==='cutting')
    if(!current) return
    const remaining=queue.filter((person)=>person.id!==current.id)
    const now=Date.now()
    if(remaining[0]) remaining[0]={...remaining[0],status:'cutting',startedAt:now}
    const alerts=remaining.map((person,index)=>{
      const wait=getWaitMinutes(remaining,index,now)
      const ahead=index
      const position=index+1
      const message=index===0
        ? `É sua vez! Você está na posição #${position}, com ${ahead} pessoas na frente. Dirija-se à barbearia.`
        : `Você está na posição #${position}, com ${ahead} ${ahead===1?'pessoa':'pessoas'} na frente. Espera aproximada: ${formatWait(wait)}.`
      return {id:`notice-${now}-${person.id}`,name:person.name,position,ahead,wait,message}
    })
    setQueue(remaining)
    setCompleted((history)=>[{id:`done-${Date.now()}`,name:current.name,service:current.service,date:'Agora (demonstração)',createdAt:Date.now(),amountCents:2000},...history])
    setNotifications(alerts)
    setNotice(remaining[0]?`Corte finalizado. ${remaining[0].name} está cortando agora.`:'Corte finalizado. A fila está vazia.')
    window.setTimeout(()=>setNotice(''),4000)
  }
  const value=useMemo(()=>({queue,completed,notifications,notice,addCustomer,removeCustomer,finishCurrent}),[queue,completed,notifications,notice])
  return <QueueContext.Provider value={value}><div className="app-shell"><Header/><Routes><Route path="/" element={<LobbyPage/>}/><Route path="/fila" element={<QueuePage/>}/><Route path="/entrar-na-fila" element={<JoinQueue/>}/><Route path="/admin" element={<AdminArea/>}/><Route path="/admin/historico" element={<AdminArea history/>}/><Route path="/admin/controle" element={<AdminArea control/>}/><Route path="/demo/admin" element={<AdminDemo/>}/><Route path="/demo/historico" element={<HistoryPage/>}/><Route path="*" element={<LobbyPage/>}/></Routes></div></QueueContext.Provider>
}
