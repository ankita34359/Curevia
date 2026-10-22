import { Link } from 'react-router-dom'
import { Avatar, Button } from './ui.jsx'
import { rupees } from '../lib/format.js'

export function DoctorCard({ doctor: d, index = 0, selected = false, onSelect, bookHref }) {
  const next = d.nextAvailable
  const body = (
    <>
      <div className="flex items-start gap-4">
        <Avatar name={d.name} photoUrl={d.photoUrl} size={64} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{bookHref ? <Link to={`/doctors/${d.id}`} className="after:absolute after:inset-0 after:rounded-2xl hover:underline">{d.name}</Link> : d.name}</h3>
          <p className="text-sm text-brand-700">{d.department}</p>
          <p className="truncate text-xs text-ink-muted">{d.qualification}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div><dt className="text-xs text-ink-muted">Experience</dt><dd className="font-medium">{d.experienceYears} years</dd></div>
        <div><dt className="text-xs text-ink-muted">Consultation fee</dt><dd className="font-medium">{rupees(d.fee)}</dd></div>
        <div className="col-span-2"><dt className="text-xs text-ink-muted">Languages</dt><dd className="font-medium">{d.languages.join(', ') || '—'}</dd></div>
      </dl>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-sm">
          <span className="block text-xs text-ink-muted">Next available</span>
          {next ? <span className="font-semibold text-brand-800">{next.dateIst}, {next.timeIst}</span> : <span className="text-ink-muted">No slots right now</span>}
        </p>
        {bookHref && <Link to={bookHref} className="relative z-10" aria-label={`Book ${d.name}`}><Button size="sm" variant="accent" disabled={!next} tabIndex={-1}>Book</Button></Link>}
        {onSelect && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selected ? 'bg-brand-700 text-white' : 'bg-brand-50 text-brand-800'}`}>{selected ? 'Selected ✓' : 'Choose'}</span>}
      </div>
    </>
  )
  const cls = `card relative block w-full animate-fade-up p-5 text-left transition duration-200 hover:-translate-y-1 hover:shadow-lg ${selected ? 'ring-2 ring-brand-600' : ''}`
  const style = { animationDelay: `${Math.min(index, 8) * 50}ms` }
  if (onSelect) return <button type="button" onClick={() => onSelect(d)} aria-pressed={selected} className={cls} style={style}>{body}</button>
  return <article className={cls} style={style}>{body}</article>
}

export function DoctorCardSkeleton() {
  return <div className="card h-64 animate-pulse p-5" aria-hidden="true"><div className="flex gap-4"><div className="h-16 w-16 rounded-full bg-slate-200" /><div className="flex-1 space-y-2"><div className="h-4 w-2/3 rounded bg-slate-200" /><div className="h-3 w-1/2 rounded bg-slate-200" /></div></div><div className="mt-6 space-y-2"><div className="h-3 rounded bg-slate-200" /><div className="h-3 rounded bg-slate-200" /></div></div>
}
