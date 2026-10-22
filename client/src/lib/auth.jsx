import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from './api.js'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export const homeFor = (role) => (role === 'admin' ? '/admin' : role === 'doctor' ? '/doctor' : '/')

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const { user } = await api('/auth/me')
      setUser(user)
      return user
    } catch {
      setUser(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const value = useMemo(
    () => ({
      user,
      loading,
      refresh,
      async login(email, password) {
        const { user } = await api('/auth/login', { method: 'POST', body: { email, password } })
        setUser(user)
        return user
      },
      async signup(name, email, password) {
        const { user } = await api('/auth/signup', { method: 'POST', body: { name, email, password } })
        setUser(user)
        return user
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' })
        setUser(null)
      }
    }),
    [user, loading, refresh]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
