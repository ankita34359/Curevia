import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useAuth, homeFor } from '../lib/auth.jsx'
import { Alert, Button, Field, Input, Logo, Skeleton } from '../components/ui.jsx'

function AuthCard({ title, subtitle, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-white to-sky-50 p-6">
      <div className="w-full max-w-md animate-fade-up">
        <Link to="/" className="mb-6 flex justify-center" aria-label="Curevia home"><Logo /></Link>
        <div className="card p-8">
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-soft">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return {
    busy,
    error,
    async run(e) {
      e.preventDefault()
      setBusy(true)
      setError('')
      try { await fn() } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
  }
}

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const form = useSubmit(async () => {
    const user = await login(email, password)
    const next = params.get('next')
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(user.role), { replace: true })
  })
  return (
    <AuthCard title="Welcome back" subtitle="Sign in to Curevia. Doctors and admins use the same page.">
      <form onSubmit={form.run} className="space-y-4">
        {form.error && <Alert tone="error">{form.error}</Alert>}
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" loading={form.busy} className="w-full">Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-soft">New patient? <Link to="/signup" className="font-semibold text-brand-700 hover:underline">Create an account</Link></p>
    </AuthCard>
  )
}

export function SignupPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const [f, setF] = useState({ name: '', email: '', password: '' })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const form = useSubmit(async () => {
    await signup(f.name, f.email, f.password)
    navigate('/', { replace: true })
  })
  return (
    <AuthCard title="Create your account" subtitle="We'll email you a link to verify your address before you book.">
      <form onSubmit={form.run} className="space-y-4">
        {form.error && <Alert tone="error">{form.error}</Alert>}
        <Field label="Full name">{(id) => <Input id={id} autoComplete="name" required minLength={2} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={f.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 8 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={f.password} onChange={set('password')} />}</Field>
        <Button type="submit" loading={form.busy} className="w-full">Create account</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-soft">Already registered? <Link to="/login" className="font-semibold text-brand-700 hover:underline">Sign in</Link></p>
    </AuthCard>
  )
}

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const { refresh } = useAuth()
  const [state, setState] = useState({ status: 'working', message: '' })
  useEffect(() => {
    let live = true
    api('/auth/verify-email', { method: 'POST', body: { token: params.get('token') || '' } })
      .then(() => { refresh(); live && setState({ status: 'ok' }) })
      .catch((e) => live && setState({ status: 'error', message: e.message }))
    return () => { live = false }
  }, [params, refresh])
  return (
    <AuthCard title="Email verification">
      {state.status === 'working' && <Skeleton className="h-10 w-full" />}
      {state.status === 'ok' && (<><Alert tone="success">Your email is verified. You can now book appointments.</Alert><Link to="/"><Button className="mt-6 w-full">Continue</Button></Link></>)}
      {state.status === 'error' && (<><Alert tone="error">{state.message}</Alert><Link to="/login"><Button variant="secondary" className="mt-6 w-full">Go to sign in</Button></Link></>)}
    </AuthCard>
  )
}

export function SetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const navigate = useNavigate()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  useEffect(() => {
    api(`/auth/set-password-info?token=${encodeURIComponent(token)}`).then(setInfo).catch((e) => setLoadError(e.message))
  }, [token])
  const form = useSubmit(async () => {
    await api('/auth/set-password', { method: 'POST', body: { token, password } })
    setDone(true)
    setTimeout(() => navigate('/login'), 1800)
  })
  return (
    <AuthCard title="Set your password" subtitle={info ? `Welcome, ${info.name}. Choose a password for ${info.email}.` : undefined}>
      {loadError && <Alert tone="error">{loadError}</Alert>}
      {!info && !loadError && <Skeleton className="h-24 w-full" />}
      {done && <Alert tone="success">Password saved. Taking you to sign in…</Alert>}
      {info && !done && (
        <form onSubmit={form.run} className="space-y-4">
          {form.error && <Alert tone="error">{form.error}</Alert>}
          <Field label="New password" hint="At least 8 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button type="submit" loading={form.busy} className="w-full">Save password</Button>
        </form>
      )}
    </AuthCard>
  )
}
