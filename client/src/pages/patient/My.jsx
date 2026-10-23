import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { Alert, Avatar, Button, EmptyState, Modal, Skeleton, StatusBadge } from '../../components/ui.jsx'
import { countdown } from '../../lib/dates.js'
import { checklistFor } from '../../config/content.js'
import { iconFor } from '../../lib/format.js'

const CANCEL_CUTOFF_MS = 60 * 60 * 1000

function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t) }, [intervalMs])
  return now
}

// Loads the patient's appointments and refreshes them every 30 s (and when the tab is shown again), so statuses stay live.
function useAppointments() {
  const [state, setState] = useState({ data: null, error: '' })
  const load = useCallback(async () => {
    try { setState({ data: await api('/patient/appointments'), error: '' }) } catch (e) { setState((s) => ({ ...s, error: e.message })) }
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    const onVis = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [load])
  return { ...state, reload: load }
}

function Checklist({ appointment }) {
  const items = checklistFor(appointment.department)
  const key = `curevia-checklist-${appointment.id}`
  const [done, setDone] = useState(() => { try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] } })
  const toggle = (i) => {
    const next = done.includes(i) ? done.filter((x) => x !== i) : [...done, i]
    setDone(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode: the ticks just won't be remembered */ }
  }
  return (
    <div>
      <h3 className="font-semibold">Prepare for your visit</h3>
      <ul className="mt-3 space-y-2">
        {items.map((t, i) => (
          <li key={t}><label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} className="mt-0.5 h-4 w-4 accent-brand-700" /><span className={done.includes(i) ? 'text-ink-muted line-through' : ''}>{t}</span></label></li>
        ))}
      </ul>
    </div>
  )
}

function MyVisit({ a, now, onChanged }) {
  const [cancelling, setCancelling] = useState(false)
  const cd = countdown(a.startUtc, a.endUtc, now)
  const tooLate = new Date(a.startUtc).getTime() - now < CANCEL_CUTOFF_MS
  return (
    <section className="card animate-fade-up overflow-hidden" aria-labelledby="visit-h">
      <div className="bg-gradient-to-br from-brand-700 to-sky-600 p-6 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p id="visit-h" className="text-sm font-semibold uppercase tracking-widest text-brand-100">My visit</p>
            <p className="mt-2 text-3xl font-bold">{a.startIst}</p>
            <p className="mt-1 text-brand-50">{a.doctorName} · {a.department}</p>
          </div>
          <div className="text-right">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-bold text-ink shadow-sm">
              <span className={`h-2 w-2 rounded-full ${a.status === 'confirmed' ? 'bg-brand-600' : 'bg-accent-400'} animate-pulse`} aria-hidden="true" />
              <span aria-live="polite">{a.status === 'confirmed' ? 'Confirmed' : 'Waiting for confirmation'}</span>
            </span>
            <p className="mt-4 text-2xl font-bold" aria-live="polite">{cd.text}</p>
          </div>
        </div>
      </div>
      <div className="grid gap-8 p-6 md:grid-cols-2">
        <div>
          {a.status === 'pending' && <Alert tone="warn" className="mb-4">Your doctor hasn't confirmed yet. We'll email you the moment they do.</Alert>}
          <p className="text-sm text-ink-soft"><span className="text-ink-muted">Reason:</span> {a.reason}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href={`/api/patient/appointments/${a.id}/calendar.ics`}><Button variant="secondary">📅 Add to calendar</Button></a>
            <Button variant="ghost" className="!text-red-700" disabled={tooLate} onClick={() => setCancelling(true)}>Cancel appointment</Button>
          </div>
          {tooLate && <p className="mt-2 text-xs text-ink-muted">Cancelling closes 1 hour before the visit. Please call the hospital if you can't make it.</p>}
        </div>
        <Checklist appointment={a} />
      </div>
      {cancelling && <CancelDialog a={a} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); onChanged() }} />}
    </section>
  )
}

export function CancelDialog({ a, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function go() {
    setBusy(true); setError('')
    try { await api(`/patient/appointments/${a.id}/cancel`, { method: 'POST', body: { reason: reason || undefined } }); onDone() } catch (e) { setError(e.message); setBusy(false) }
  }
  return (
    <Modal title="Are you sure?" onClose={onClose}>
      <p className="font-medium">{a.startIst} with {a.doctorName}</p>
      <p className="mt-1 text-ink-soft">{a.status === 'needs_rebooking' ? "You won't be offered a new time for this visit." : 'This frees your slot, so someone else can book it.'}</p>
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      <label className="mt-4 block text-sm font-medium" htmlFor="why">Reason (optional)</label>
      <input id="why" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
      <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Keep it</Button><Button variant="danger" loading={busy} onClick={go}>Yes, cancel</Button></div>
    </Modal>
  )
}

const DOT = { completed: 'bg-brand-600', no_show: 'bg-slate-400', cancelled_by_patient: 'bg-red-400', cancelled_by_doctor: 'bg-red-400', rebooked: 'bg-slate-300', expired: 'bg-slate-400', confirmed: 'bg-brand-600', pending: 'bg-accent-400' }

function Timeline({ items }) {
  return (
    <ol className="relative ml-3 border-l-2 border-slate-200">
      {items.map((a, i) => (
        <li key={a.id} className="mb-6 ml-6 animate-fade-up" style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}>
          <span className={`absolute -left-[9px] mt-1.5 h-4 w-4 rounded-full border-2 border-white ${DOT[a.status] || 'bg-slate-300'}`} aria-hidden="true" />
          <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div><p className="font-semibold">{a.doctorName} <span className="font-normal text-ink-muted">· {a.department}</span></p><p className="text-sm text-ink-soft">{a.startIst}</p>{a.labReport && <div className="mt-2" data-testid="lab-badge"><span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-900"><span aria-hidden="true">🧪</span> Lab report ready</span>{a.labReport.note && <p className="mt-1 text-sm text-ink-soft">{a.labReport.note}</p>}</div>}{a.cancelReason && <p className="mt-1 text-xs text-ink-muted">Reason: {a.cancelReason}</p>}</div>
            <div className="flex items-center gap-3"><StatusBadge status={a.status} />{a.status === 'expired' && <Link to="/doctors" className="text-sm font-semibold text-brand-700 hover:underline">Book again</Link>}{a.status === 'completed' && (a.feedbackRating ? <span className="text-sm text-ink-soft" data-testid="your-rating">You rated this visit {a.feedbackRating}/5</span> : <Link to={`/my/feedback/${a.id}`} className="text-sm font-semibold text-brand-700 hover:underline" data-testid="give-feedback">Give feedback</Link>)}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

export default function My() {
  const { data, error, reload } = useAppointments()
  const now = useNow()
  const [cancelFor, setCancelFor] = useState(null)
  if (!data) return <div className="mx-auto max-w-5xl space-y-4 px-6 py-10"><Skeleton className="h-48" /><Skeleton className="h-24" /></div>
  const [next, ...later] = data.upcoming
  const empty = !next && data.needsRebooking.length === 0 && data.past.length === 0

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-end justify-between"><h1 className="text-3xl font-bold tracking-tight">My appointments</h1><Link to="/book"><Button variant="accent">Book new</Button></Link></div>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {data.needsRebooking.map((a) => (
        <Alert key={a.id} tone="warn" className="mb-4 animate-fade-up">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="font-semibold">Your appointment with {a.doctorName} on {a.startIst} needs a new time.</p>{a.cancelReason && <p className="mt-0.5 text-sm">Reason: {a.cancelReason}</p>}</div>
            <div className="flex gap-2"><Link to={`/my/rebook/${a.id}`}><Button size="sm">Pick a new time</Button></Link><Button size="sm" variant="secondary" onClick={() => setCancelFor(a)}>Cancel it</Button></div>
          </div>
        </Alert>
      ))}
      {empty && <EmptyState title="No appointments yet" icon="🗓️">When you book a visit it will show up here, with a countdown and a checklist to help you get ready. <Link to="/doctors" className="font-semibold text-brand-700 underline">Find a doctor</Link></EmptyState>}
      {next && <MyVisit a={next} now={now} onChanged={reload} />}
      {later.length > 0 && (
        <section className="mt-10" aria-labelledby="later-h">
          <h2 id="later-h" className="mb-3 text-lg font-semibold">Also coming up</h2>
          <div className="space-y-3">{later.map((a) => (
            <div key={a.id} className="card flex flex-wrap items-center justify-between gap-3 p-4"><div className="flex items-center gap-3"><Avatar name={a.doctorName} size={40} /><div><p className="font-semibold">{a.doctorName}</p><p className="text-sm text-ink-soft">{a.startIst}</p></div></div><div className="flex items-center gap-3"><StatusBadge status={a.status} /><a href={`/api/patient/appointments/${a.id}/calendar.ics`} className="text-sm font-semibold text-brand-700 hover:underline">Add to calendar</a><Button size="sm" variant="ghost" className="!text-red-700" onClick={() => setCancelFor(a)}>Cancel</Button></div></div>
          ))}</div>
        </section>
      )}
      {data.past.length > 0 && <section className="mt-10" aria-labelledby="hist-h"><h2 id="hist-h" className="mb-4 text-lg font-semibold">Visit history</h2><Timeline items={data.past} /></section>}
      {cancelFor && <CancelDialog a={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); reload() }} />}
    </div>
  )
}

export function Rebook() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  useEffect(() => { api(`/patient/appointments/${id}/rebook-options`).then(setData).catch((e) => setError(e.message)) }, [id])

  async function confirm() {
    setBusy(true); setError('')
    try { setDone((await api(`/patient/appointments/${id}/rebook`, { method: 'POST', body: { doctorId: pick.doctorId, startUtc: pick.startUtc } })).appointment) } catch (e) { setError(e.message); setBusy(false); api(`/patient/appointments/${id}/rebook-options`).then(setData).catch(() => {}); setPick(null) }
  }
  if (done) return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center"><div className="mx-auto flex h-20 w-20 animate-fade-up items-center justify-center rounded-full bg-brand-100 text-4xl text-brand-700" aria-hidden="true">✓</div><h1 className="mt-6 text-3xl font-bold">You're rebooked</h1><p className="mt-2 text-ink-soft">{done.doctorName} · {done.startIst}. {done.status === 'confirmed' ? 'This visit is confirmed.' : 'The doctor will confirm it soon.'}</p><Link to="/my"><Button className="mt-8">Back to my appointments</Button></Link></div>
  )
  if (!data && !error) return <div className="mx-auto max-w-3xl px-6 py-10"><Skeleton className="h-64" /></div>
  const groups = {}
  for (const o of data?.options || []) (groups[o.startIst.split(',')[0]] ||= []).push(o)

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Pick a new time</h1>
      {data && data.appointment.status === 'pending' && <p className="mt-1 text-ink-soft">Your request with {data.appointment.doctorName} on {data.appointment.startIst} is still waiting for the doctor. If you pick another time below, it replaces that request.</p>}
      {data && data.appointment.status !== 'pending' && <p className="mt-1 text-ink-soft">Your visit with {data.appointment.doctorName} on {data.appointment.startIst} can't go ahead{data.appointment.cancelReason ? ` (${data.appointment.cancelReason})` : ''}. Choose another slot below.</p>}
      {error && <Alert tone="error" className="mt-4">{error}</Alert>}
      {data && data.options.length === 0 && <EmptyState title="No free slots right now" icon="⏳">The hospital will be in touch. You can also check back soon.</EmptyState>}
      <div className="mt-6 space-y-6">
        {Object.entries(groups).map(([day, opts]) => (
          <div key={day} className="animate-fade-up"><h2 className="mb-2 text-sm font-semibold text-ink-soft">{day}</h2>
            <div className="grid gap-2 sm:grid-cols-2">{opts.map((o) => {
              const sel = pick?.startUtc === o.startUtc && pick?.doctorId === o.doctorId
              return <button key={`${o.doctorId}-${o.startUtc}`} aria-pressed={sel} onClick={() => setPick(o)} className={`rounded-xl border p-3 text-left transition ${sel ? 'border-brand-700 bg-brand-700 text-white shadow-md' : 'border-slate-200 bg-white hover:border-brand-400 hover:bg-brand-50'}`}><span className="block font-semibold">{o.startIst.split(', ')[1]}</span><span className={`block text-sm ${sel ? 'text-brand-100' : 'text-ink-soft'}`}>{o.doctorName}</span></button>
            })}</div></div>
        ))}
      </div>
      {pick && <div className="sticky bottom-4 mt-8 flex items-center justify-between gap-4 rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200 animate-fade-up"><p className="text-sm"><strong>{pick.startIst}</strong> with {pick.doctorName}</p><Button variant="accent" loading={busy} onClick={confirm}>Confirm this time</Button></div>}
    </div>
  )
}
