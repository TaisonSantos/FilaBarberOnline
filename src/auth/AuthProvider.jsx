import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

const AuthContext = createContext(null)

async function checkAdmin(userId) {
  if (!supabase || !userId) return false
  const { data, error } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(isSupabaseConfigured)

  useEffect(() => {
    if (!supabase) return undefined
    let alive = true

    const loadSession = async () => {
      const { data, error } = await supabase.auth.getSession()
      if (!alive) return
      if (error) {
        setLoading(false)
        return
      }
      setSession(data.session)
      if (data.session?.user) {
        try {
          setIsAdmin(await checkAdmin(data.session.user.id))
        } catch {
          setIsAdmin(false)
        }
      }
      if (alive) setLoading(false)
    }
    void loadSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (!nextSession) {
        setIsAdmin(false)
        setLoading(false)
        return
      }
      window.setTimeout(async () => {
        try {
          const allowed = await checkAdmin(nextSession.user.id)
          if (alive) setIsAdmin(allowed)
        } catch {
          if (alive) setIsAdmin(false)
        } finally {
          if (alive) setLoading(false)
        }
      }, 0)
    })

    return () => {
      alive = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email, password) => {
    if (!supabase) throw new Error('Configure a URL e a chave pública do Supabase no arquivo .env.local.')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    let allowed = false
    try {
      allowed = await checkAdmin(data.user.id)
    } catch (membershipError) {
      await supabase.auth.signOut()
      throw membershipError
    }
    if (!allowed) {
      await supabase.auth.signOut()
      throw new Error('Esta conta não está autorizada como proprietária no banco.')
    }
    setSession(data.session)
    setIsAdmin(true)
  }

  const signOut = async () => {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setSession(null)
    setIsAdmin(false)
  }

  const value = useMemo(() => ({ session, user: session?.user ?? null, isAdmin, loading, configured: isSupabaseConfigured, signIn, signOut }), [session, isAdmin, loading])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider.')
  return context
}
