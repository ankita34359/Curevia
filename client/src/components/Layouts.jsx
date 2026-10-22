import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Logo, Button, Alert } from './ui.jsx'
import { HOSPITAL } from '../config/content.js'
import { useAuth } from '../lib/auth.jsx'

const navLink = ({ isActive }) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-soft hover:bg-slate-100'}`

// Top navigation bar: patients and signed-out visitors.
export function PatientLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
          <Link to="/" aria-label="Curevia home"><Logo /></Link>
          <nav className="flex flex-1 items-center gap-1" aria-label="Main">
            <NavLink to="/" end className={navLink}>Home</NavLink>
            <NavLink to="/doctors" className={navLink}>Find a doctor</NavLink>
            {user?.role === 'patient' && <NavLink to="/my" className={navLink}>My appointments</NavLink>}
          </nav>
          <EmergencyBadge />
          {user ? (
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-ink-soft md:inline">{user.name}</span>
              <Button variant="secondary" size="sm" onClick={async () => { await logout(); navigate('/') }}>Sign out</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-ink-soft hover:bg-slate-100">Sign in</Link>
              <Link to="/signup" className="rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800">Create account</Link>
            </div>
          )}
        </div>
      </header>
      {user?.role === 'patient' && !user.emailVerified && <VerifyBanner />}
      <main className="flex-1"><Outlet /></main>
      <Footer />
    </div>
  )
}

export function EmergencyBadge() {
  return (
    <a href={`tel:${HOSPITAL.emergencyNumber}`} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-bold text-red-700 transition hover:bg-red-100" aria-label={`Emergency? Call ${HOSPITAL.emergencyNumber}`}>
      <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden="true" />
      Emergency? Call {HOSPITAL.emergencyNumber}
    </a>
  )
}

function Footer() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const link = 'text-sm text-slate-300 transition hover:text-white hover:underline'
  return (
    <footer className="mt-8 bg-ink text-slate-200">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-12 md:grid-cols-4">
        <div className="md:col-span-1">
          <Logo light />
          <p className="mt-3 text-sm text-slate-300">Book hospital appointments online, with confirmations and reminders by email.</p>
        </div>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white">Contact</h2>
          <address className="mt-3 text-sm not-italic text-slate-300">
            {HOSPITAL.address.map((l) => <span key={l} className="block">{l}</span>)}
            <a href={HOSPITAL.phoneHref} className="mt-2 block font-medium text-white hover:underline">{HOSPITAL.phone}</a>
          </address>
        </div>
        <nav aria-label="Quick links">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white">Quick links</h2>
          <ul className="mt-3 space-y-2">
            <li><Link to="/" className={link}>Home</Link></li>
            <li><Link to="/doctors" className={link}>Find a doctor</Link></li>
            <li><Link to="/my" className={link}>My appointments</Link></li>
            <li>{user ? <button className={link} onClick={async () => { await logout(); navigate('/') }}>Sign out</button> : <Link to="/login" className={link}>Sign in</Link>}</li>
          </ul>
        </nav>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white">Emergency</h2>
          <a href={`tel:${HOSPITAL.emergencyNumber}`} className="mt-3 inline-block rounded-xl bg-red-600 px-4 py-2 text-lg font-bold text-white transition hover:bg-red-700">Call {HOSPITAL.emergencyNumber}</a>
          <p className="mt-2 text-xs text-slate-400">For a medical emergency, do not wait for an appointment.</p>
        </div>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-xs text-slate-400">© Curevia. All appointment times are shown in India time (IST).</div>
    </footer>
  )
}

function VerifyBanner() {
  const { refresh } = useAuth()
  return (
    <div className="mx-auto mt-4 w-full max-w-7xl px-6">
      <Alert tone="warn">
        Please verify your email to book appointments - we sent you a link.{' '}
        <button className="font-semibold underline" onClick={async () => { await fetch('/api/auth/resend-verification', { method: 'POST', credentials: 'same-origin' }); refresh() }}>
          Send it again
        </button>
      </Alert>
    </div>
  )
}

// Left sidebar: doctor and admin dashboards.
export function DashboardLayout({ title, items }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white p-5 md:flex">
        <Link to="/" aria-label="Curevia home"><Logo /></Link>
        <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">{title}</p>
        <nav className="mt-6 flex flex-1 flex-col gap-1" aria-label="Dashboard">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={navLink}>{i.label}</NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200/70 pt-4">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-ink-muted">{user.email}</p>
          <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={async () => { await logout(); navigate('/login') }}>Sign out</Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8"><div className="mx-auto max-w-6xl"><Outlet /></div></main>
    </div>
  )
}
