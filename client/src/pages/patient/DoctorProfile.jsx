import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { Avatar, Button, EmptyState, Skeleton, useLoad } from '../../components/ui.jsx'
import { rupees } from '../../lib/format.js'

export default function DoctorProfile() {
  const { id } = useParams()
  const doc = useLoad(() => api(`/public/doctors/${id}`).then((r) => r.doctor), [id])
  const slots = useLoad(() => api(`/public/doctors/${id}/next-slots`).then((r) => r.slots), [id])
  const [picked, setPicked] = useState(null)

  if (doc.error) return <div className="mx-auto max-w-3xl px-6 py-10"><EmptyState title="We couldn't find that doctor" icon="🔎"><Link to="/doctors" className="font-semibold text-brand-700 underline">See all doctors</Link></EmptyState></div>
  if (doc.loading || !doc.data) return <div className="mx-auto max-w-5xl space-y-4 px-6 py-10"><Skeleton className="h-40" /><Skeleton className="h-56" /></div>
  const d = doc.data
  const byDay = {}
  for (const s of slots.data || []) (byDay[s.dateIst] ||= []).push(s)

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Link to="/doctors" className="text-sm font-semibold text-brand-700 hover:underline">← All doctors</Link>
      <div className="mt-4 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section className="card animate-fade-up p-8" aria-labelledby="doc-h">
          <div className="flex items-center gap-5">
            <Avatar name={d.name} photoUrl={d.photoUrl} size={96} />
            <div>
              <h1 id="doc-h" className="text-3xl font-bold tracking-tight">{d.name}</h1>
              <p className="mt-1 font-medium text-brand-700">{d.department}</p>
              <p className="text-sm text-ink-muted">{d.qualification}</p>
            </div>
          </div>
          <dl className="mt-8 grid grid-cols-3 gap-4 rounded-2xl bg-brand-50/60 p-5 text-center">
            <div><dt className="text-xs text-ink-muted">Experience</dt><dd className="mt-1 text-lg font-bold">{d.experienceYears} yrs</dd></div>
            <div><dt className="text-xs text-ink-muted">Consultation fee</dt><dd className="mt-1 text-lg font-bold">{rupees(d.fee)}</dd></div>
            <div><dt className="text-xs text-ink-muted">Languages</dt><dd className="mt-1 text-sm font-bold">{d.languages.join(', ') || '—'}</dd></div>
          </dl>
          <h2 className="mt-8 text-lg font-semibold">About</h2>
          <p className="mt-2 text-ink-soft">{d.about || 'This doctor has not added an introduction yet.'}</p>
        </section>

        <section className="card h-fit animate-fade-up p-6" style={{ animationDelay: '80ms' }} aria-labelledby="slots-h">
          <h2 id="slots-h" className="text-lg font-semibold">Next free slots</h2>
          <p className="text-sm text-ink-muted">India time (IST). Pick one to book.</p>
          {slots.loading && <div className="mt-4 space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
          {slots.data?.length === 0 && <p className="mt-4 rounded-xl bg-slate-100 p-4 text-sm text-ink-soft">No free slots in the next 30 days. Please check back soon.</p>}
          <div className="mt-4 space-y-4">
            {Object.entries(byDay).map(([day, list]) => (
              <div key={day}>
                <h3 className="mb-2 text-sm font-semibold text-ink-soft">{day}</h3>
                <div className="flex flex-wrap gap-2">
                  {list.map((s) => (
                    <button key={s.startUtc} aria-pressed={picked === s.startUtc} onClick={() => setPicked(s.startUtc)}
                      className={`rounded-xl border px-3 py-2 text-sm font-semibold tabular-nums transition duration-150 ${picked === s.startUtc ? 'scale-105 border-brand-700 bg-brand-700 text-white shadow-md' : 'border-slate-300 bg-white hover:-translate-y-0.5 hover:border-brand-500 hover:bg-brand-50'}`}>{s.timeIst}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-col gap-2">
            <Link to={picked ? `/book?doctor=${d.id}&slot=${encodeURIComponent(picked)}` : `/book?doctor=${d.id}`}>
              <Button variant="accent" size="lg" className="w-full" disabled={slots.data?.length === 0}>{picked ? 'Book this slot' : 'Book appointment'}</Button>
            </Link>
            {!picked && slots.data?.length > 0 && <p className="text-center text-xs text-ink-muted">Or choose another day on the next page.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}
