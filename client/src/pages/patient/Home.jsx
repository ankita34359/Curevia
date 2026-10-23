import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { Button, useLoad } from '../../components/ui.jsx'
import { DoctorCard, DoctorCardSkeleton } from '../../components/DoctorCard.jsx'
import { iconFor } from '../../lib/format.js'
import { HEALTH_TIPS, HEALTH_TIPS_NOTE, HOW_IT_WORKS } from '../../config/content.js'

function SearchBar() {
  const navigate = useNavigate()
  const deps = useLoad(() => api('/public/departments'))
  const docs = useLoad(() => api('/public/doctors'))
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const suggestions = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    const d = (deps.data?.departments || []).filter((x) => x.name.toLowerCase().includes(t)).slice(0, 3).map((x) => ({ key: `d${x.id}`, label: x.name, sub: 'Department', icon: iconFor(x.icon), to: `/doctors?department=${x.id}` }))
    const p = (docs.data?.doctors || []).filter((x) => x.name.toLowerCase().includes(t)).slice(0, 4).map((x) => ({ key: `p${x.id}`, label: x.name, sub: x.department, icon: '👩‍⚕️', to: `/doctors/${x.id}` }))
    return [...d, ...p]
  }, [q, deps.data, docs.data])

  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); navigate(q.trim() ? `/doctors?q=${encodeURIComponent(q.trim())}` : '/doctors') }} className="relative mx-auto mt-8 flex max-w-2xl items-center gap-2 rounded-2xl bg-white p-2 shadow-card ring-1 ring-slate-200/70">
      <span className="pl-3 text-ink-muted" aria-hidden="true">🔍</span>
      <input aria-label="Search for a doctor or department" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search a doctor or department, e.g. Pediatrics" className="min-w-0 flex-1 bg-transparent px-2 py-3 text-base outline-none placeholder:text-slate-400 focus-visible:ring-0" />
      <Button type="submit" variant="accent" size="lg">Book appointment</Button>
      {open && suggestions.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-10 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl animate-fade-up">
          {suggestions.map((s) => (
            <li key={s.key}><Link to={s.to} className="flex items-center gap-3 px-4 py-3 hover:bg-brand-50"><span aria-hidden="true" className="text-xl">{s.icon}</span><span><span className="block font-medium">{s.label}</span><span className="block text-xs text-ink-muted">{s.sub}</span></span></Link></li>
          ))}
        </ul>
      )}
    </form>
  )
}

export default function Home() {
  const { user } = useAuth()
  const deps = useLoad(() => api('/public/departments'))
  const featured = useLoad(() => api('/public/doctors?featured=1'))
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-sky-600 text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-sky-300/20 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto max-w-5xl px-6 pb-20 pt-16 text-center">
          <p className="animate-fade-up text-sm font-semibold uppercase tracking-widest text-brand-100">Hospital appointments, made simple</p>
          <h1 className="mx-auto mt-3 max-w-3xl animate-fade-up text-5xl font-bold leading-tight tracking-tight" style={{ animationDelay: '60ms' }}>Find the right doctor and book a time in minutes</h1>
          <p className="mx-auto mt-4 max-w-xl animate-fade-up text-lg text-brand-50" style={{ animationDelay: '120ms' }}>See real free slots, request your visit, and we'll keep you updated by email.</p>
          <div className="animate-fade-up text-ink" style={{ animationDelay: '180ms' }}><SearchBar /></div>
          {user?.role === 'patient' && (
            <div className="mt-5 animate-fade-up" style={{ animationDelay: '240ms' }}>
              <Link to="/book-with-ai"><Button size="lg" className="!bg-white !text-brand-800 hover:!bg-brand-50" data-testid="book-with-ai-button"><span aria-hidden="true">✨</span> Book with AI</Button></Link>
              <p className="mt-2 text-sm text-brand-50">Describe what you need and we suggest a department and free slots.</p>
            </div>
          )}
        </div>
      </section>

      <section className="bg-white py-14" aria-labelledby="how-h">
        <div className="mx-auto max-w-7xl px-6">
          <h2 id="how-h" className="text-center text-2xl font-bold">How it works</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {HOW_IT_WORKS.map((s, i) => (
              <li key={s.title} className="relative animate-fade-up rounded-2xl bg-gradient-to-br from-brand-50 to-sky-50 p-6 text-center" style={{ animationDelay: `${i * 80}ms` }}>
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-3xl shadow-sm" aria-hidden="true">{s.icon}</span>
                <p className="mt-4 text-xs font-bold uppercase tracking-widest text-brand-700">Step {i + 1}</p>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-ink-soft">{s.text}</p>
                {i < HOW_IT_WORKS.length - 1 && <span className="absolute -right-5 top-1/2 z-10 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-brand-700 text-white shadow md:flex" aria-hidden="true">→</span>}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-14" aria-labelledby="dept-h">
        <div className="mb-6 flex items-end justify-between"><h2 id="dept-h" className="text-2xl font-bold">Browse by department</h2><Link to="/doctors" className="text-sm font-semibold text-brand-700 hover:underline">All doctors →</Link></div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {deps.loading && [0, 1, 2, 3].map((i) => <div key={i} className="card h-32 animate-pulse" />)}
          {deps.data?.departments.map((d, i) => (
            <Link key={d.id} to={`/doctors?department=${d.id}`} className="card group animate-fade-up p-5 transition duration-200 hover:-translate-y-1 hover:shadow-lg" style={{ animationDelay: `${i * 50}ms` }}>
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-2xl transition group-hover:scale-110 group-hover:bg-brand-100" aria-hidden="true">{iconFor(d.icon)}</span>
              <h3 className="mt-3 font-semibold">{d.name}</h3>
              <p className="text-sm text-ink-muted">{d.doctorCount} doctor{d.doctorCount === 1 ? '' : 's'}</p>
            </Link>
          ))}
          {deps.data?.departments.length === 0 && <p className="col-span-full text-ink-soft">Departments will appear here once the hospital adds them.</p>}
        </div>
      </section>

      <section className="bg-white py-14" aria-labelledby="feat-h">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-6 flex items-end justify-between"><h2 id="feat-h" className="text-2xl font-bold">Featured doctors</h2><Link to="/doctors" className="text-sm font-semibold text-brand-700 hover:underline">See all →</Link></div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {featured.loading && [0, 1, 2, 3].map((i) => <DoctorCardSkeleton key={i} />)}
            {featured.data?.doctors.map((d, i) => <DoctorCard key={d.id} doctor={d} index={i} browse />)}
          </div>
          {featured.data?.doctors.length === 0 && <p className="text-ink-soft">No doctors are available to book yet. Please check back soon.</p>}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-14" aria-labelledby="tips-h">
        <h2 id="tips-h" className="text-2xl font-bold">Healthy habits</h2>
        <p className="mt-1 text-sm text-ink-muted">{HEALTH_TIPS_NOTE}</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {HEALTH_TIPS.map((t, i) => (
            <div key={t.title} className="card animate-fade-up bg-gradient-to-br from-white to-sky-50/60 p-5 transition hover:-translate-y-0.5" style={{ animationDelay: `${i * 50}ms` }}>
              <span className="text-2xl" aria-hidden="true">{t.icon}</span>
              <h3 className="mt-2 font-semibold">{t.title}</h3>
              <p className="mt-1 text-sm text-ink-soft">{t.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
