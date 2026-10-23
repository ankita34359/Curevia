import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Button, EmptyState, Field, Modal, PageHeader, Skeleton, StatusBadge, Textarea, useLoad } from '../../components/ui.jsx'

export function AppointmentCard({ a, onChanged, onError }) {
  const [busy, setBusy] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [labDialog, setLabDialog] = useState(false)
  const started = new Date(a.startUtc) <= new Date()

  async function run(action) {
    setBusy(action); onError('')
    try { await api(`/doctor/appointments/${a.id}/${action}`, { method: 'POST' }); onChanged() } catch (e) { onError(e.message) } finally { setBusy('') }
  }
  return (
    <div className="card animate-fade-up p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold tabular-nums">{a.timeIst} <span className="text-sm font-normal text-ink-muted">{a.dateIst}</span></p>
          <p className="mt-0.5 font-medium">{a.patientName} <span className="font-normal text-ink-soft">· {a.age} yrs · {a.gender}</span></p>
        </div>
        <StatusBadge status={a.status} />
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-ink-muted">Reason: </dt><dd className="inline">{a.reason}</dd></div>
        <div><dt className="inline text-ink-muted">Phone: </dt><dd className="inline">{a.phone}</dd></div>
        {a.cancelReason && <div className="sm:col-span-2"><dt className="inline text-ink-muted">Cancel reason: </dt><dd className="inline">{a.cancelReason}</dd></div>}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {a.status === 'pending' && <Button size="sm" loading={busy === 'confirm'} onClick={() => run('confirm')}>Confirm</Button>}
        {(a.status === 'pending' || a.status === 'confirmed') && <Button size="sm" variant="secondary" onClick={() => setCancelling(true)}>Cancel…</Button>}
        {a.status === 'confirmed' && (
          <>
            <Button size="sm" variant="secondary" disabled={!started} loading={busy === 'complete'} onClick={() => run('complete')} title={started ? '' : 'Available once the appointment time starts'}>Mark completed</Button>
            <Button size="sm" variant="ghost" disabled={!started} loading={busy === 'no-show'} onClick={() => run('no-show')} title={started ? '' : 'Available once the appointment time starts'}>No-show</Button>
          </>
        )}
      </div>
      {a.status === 'completed' && (
        <div className="mt-4">
          {a.labReport ? (
            <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="lab-ready">
              <p className="font-semibold"><span aria-hidden="true">🧪</span> Lab report ready <span className="font-normal text-emerald-800">· marked {a.labReport.readyIst}</span></p>
              {a.labReport.note && <p className="mt-0.5">Note to the patient: {a.labReport.note}</p>}
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setLabDialog(true)}>Mark lab report ready</Button>
          )}
        </div>
      )}
      {labDialog && <LabReportDialog a={a} onClose={() => setLabDialog(false)} onDone={() => { setLabDialog(false); onChanged() }} />}
      {cancelling && <CancelDialog a={a} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); onChanged() }} />}
    </div>
  )
}

function LabReportDialog({ a, onClose, onDone }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { await api(`/doctor/appointments/${a.id}/lab-report`, { method: 'POST', body: { note } }); onDone() } catch (err) { setError(err.message); setBusy(false) }
  }
  return (
    <Modal title={`Lab report ready for ${a.patientName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="text-sm text-ink-soft">The patient gets one email saying the report is ready to collect. This can be done once. No file and no test results go in the email.</p>
        <Field label="Note for the patient (optional)">{(id) => <Textarea id={id} maxLength={200} placeholder="e.g. Collect from Lab counter, ground floor" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <p className="-mt-2 text-xs text-ink-muted">Where to collect it is enough. Please do not write test results here. {note.length}/200</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Not yet</Button><Button type="submit" loading={busy}>Mark lab report ready</Button></div>
      </form>
    </Modal>
  )
}

function CancelDialog({ a, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [offer, setOffer] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { await api(`/doctor/appointments/${a.id}/cancel`, { method: 'POST', body: { reason, offerRebooking: offer } }); onDone() } catch (err) { setError(err.message); setBusy(false) }
  }
  return (
    <Modal title={`Cancel ${a.patientName}'s appointment`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Reason (the patient will see this)">{(id) => <Textarea id={id} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={offer} onChange={(e) => setOffer(e.target.checked)} className="mt-1 h-4 w-4 accent-brand-700" />
          <span><strong>Offer the patient another slot.</strong><br /><span className="text-ink-soft">They get new time options to pick from. Untick to cancel for good.</span></span>
        </label>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Keep appointment</Button><Button type="submit" variant="danger" loading={busy}>Cancel appointment</Button></div>
      </form>
    </Modal>
  )
}

export function AppointmentList({ scope, empty }) {
  const list = useLoad(() => api(`/doctor/appointments?scope=${scope}`), [scope])
  const [error, setError] = useState('')
  if (list.loading) return <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
  return (
    <div className="space-y-3">
      {(error || list.error) && <Alert tone="error">{error || list.error}</Alert>}
      {list.data?.appointments.length === 0 && <EmptyState title={empty.title} icon={empty.icon}>{empty.text}</EmptyState>}
      {list.data?.appointments.map((a) => <AppointmentCard key={a.id} a={a} onChanged={list.reload} onError={setError} />)}
    </div>
  )
}

export default function DoctorHome() {
  return (
    <div>
      <PageHeader title="Today" subtitle="Your schedule for today and the requests waiting for you." />
      <div className="grid gap-8 xl:grid-cols-2">
        <section aria-labelledby="today-h">
          <h2 id="today-h" className="mb-3 text-lg font-semibold">Today's appointments</h2>
          <AppointmentList scope="today" empty={{ title: 'Nothing scheduled today', icon: '☀️', text: 'Enjoy the quiet. New bookings will appear here.' }} />
        </section>
        <section aria-labelledby="pending-h">
          <h2 id="pending-h" className="mb-3 text-lg font-semibold">Pending requests</h2>
          <AppointmentList scope="pending" empty={{ title: 'No requests waiting', icon: '✅', text: "You're all caught up." }} />
        </section>
      </div>
    </div>
  )
}

export function DoctorUpcoming() {
  const [scope, setScope] = useState('upcoming')
  return (
    <div>
      <PageHeader title="Appointments" subtitle="Upcoming bookings and your history." />
      <div className="mb-5 inline-flex rounded-xl bg-slate-200/70 p-1" role="tablist">
        {[['upcoming', 'Upcoming'], ['past', 'Past']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={scope === k} onClick={() => setScope(k)} className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${scope === k ? 'bg-white shadow-sm' : 'text-ink-soft'}`}>{label}</button>
        ))}
      </div>
      <AppointmentList key={scope} scope={scope} empty={{ title: scope === 'upcoming' ? 'No upcoming appointments' : 'No past appointments yet', icon: '📅', text: 'They will show up here.' }} />
    </div>
  )
}
