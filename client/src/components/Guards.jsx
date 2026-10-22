import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth, homeFor } from '../lib/auth.jsx'
import { Skeleton, Button } from './ui.jsx'

export function PageLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-10" aria-busy="true">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

export function Forbidden() {
  const { user } = useAuth()
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center animate-fade-up">
      <p className="text-5xl" aria-hidden="true">🔒</p>
      <h1 className="mt-4 text-2xl font-bold">You don't have access to this page</h1>
      <p className="mt-2 text-ink-soft">This area is for a different kind of account.</p>
      <Link to={user ? homeFor(user.role) : '/'}><Button className="mt-6">Go to my home</Button></Link>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center animate-fade-up">
      <p className="text-5xl" aria-hidden="true">🧭</p>
      <h1 className="mt-4 text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-ink-soft">The page you are looking for does not exist.</p>
      <Link to="/"><Button className="mt-6">Back to home</Button></Link>
    </div>
  )
}

// Mirrors what the server already enforces: wrong role -> Forbidden, signed out -> sign in.
export function RequireRole({ role, children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <PageLoading />
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (user.role !== role) return <Forbidden />
  return children
}
