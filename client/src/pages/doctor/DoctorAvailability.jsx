import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { WEEKDAYS } from '../../lib/format.js'
import { Alert, Button, Field, Input, Modal, PageHeader, Select, Skeleton, useLoad } from '../../components/ui.jsx'

const SLOT_OPTIONS = [10, 15, 20, 30, 45, 60]
let nextKey = 1
const withKey = (w) => ({ ...w, key: nextKey++ })

export default function DoctorAvailability() {
  const me = useLoad(() => api('/doctor/me'))
  return (
    <div>
      <PageHeader title="Availability & leave" subtitle="Set your weekly hours. Times are India time (IST)." />
      {me.loading ? <Skeleton className="h-64" /> : (
        <div className="grid gap-8 xl:grid-cols-[1.4fr_1fr]">
          <WeeklyEditor initial={me.data.availability} onSaved={me.reload} />
          <LeavePanel leaves={me.data.leaves} onChanged={me.reload} />
        </div>
      )}
    </div>
  )
}

function WeeklyEditor({ initial, onSaved }) {
  const [windows, setWindows] = useState(() => initial.map((w) => withKey(w)))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null) // number of appointments that would move
  useEffect(() => { setWindows(initial.map((w) => withKey(w))) }, [initial])

  const update = (key, patch) => { setSaved(false); setWindows((ws) => ws.map((w) => (w.key === key ? { ...w, ...patch } : w))) }
  const body = () => ({ windows: windows.map(({ weekday, start, end, slotMinutes }) => ({ weekday, start, end, slotMinutes: Number(slotMinutes) })) })

  async function save(apply) {
    setBusy(true); setError('')
    try {
      if (!apply) {
        const p = await api('/doctor/availability?preview=1', { method: 'PUT', body: body() })
        if (p.movedToRebooking > 0) { setConfirm(p.movedToRebooking); setBusy(false); return }
      }
      await api('/doctor/availability', { method: 'PUT', body: body() })
      setConfirm(null); setSaved(true); onSaved()
    } catch (e) { setError(e.message); setConfirm(null) } finally { setBusy(false) }
  }

  return (
    <section className="card p-6" aria-labelledby="week-h">
      <h2 id="week-h" className="text-lg font-semibold">Weekly hours</h2>
      <p className="mb-4 text-sm text-ink-soft">Add one or more time blocks per day. Each block is cut into slots of the length you choose.</p>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {saved && <Alert tone="success" className="mb-4">Saved. Patients now see your new hours.</Alert>}
      <div className="divide-y divide-slate-100">
        {WEEKDAYS.map(({ n, name }) => {
          const rows = windows.filter((w) => w.weekday === n)
          return (
            <div key={n} className="flex items-start gap-4 py-3">
              <div className="w-32 shrink-0 pt-1.5">
                <p className="font-medium">{name}</p>
                <button className="mt-1 text-xs font-semibold text-brand-700 hover:underline" onClick={() => { setSaved(false); setWindows((ws) => [...ws, withKey({ weekday: n, start: '09:00', end: '13:00', slotMinutes: 15 })]) }}>+ Add block</button>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {rows.length === 0 && <p className="pt-2 text-sm text-ink-muted">Not working</p>}
                {rows.map((w) => (
                  <div key={w.key} className="flex flex-wrap items-center gap-2">
                    <Input aria-label={`${name} start`} type="time" value={w.start} onChange={(e) => update(w.key, { start: e.target.value })} className="!w-[7.75rem] !px-2.5" />
                    <span className="text-ink-muted">to</span>
                    <Input aria-label={`${name} end`} type="time" value={w.end} onChange={(e) => update(w.key, { end: e.target.value })} className="!w-[7.75rem] !px-2.5" />
                    <Select aria-label={`${name} slot length`} value={w.slotMinutes} onChange={(e) => update(w.key, { slotMinutes: e.target.value })} className="!w-[6.5rem]">
                      {SLOT_OPTIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
                    </Select>
                    <button aria-label={`Remove ${name} block`} className="rounded-lg p-2 text-ink-muted hover:bg-red-50 hover:text-red-700" onClick={() => { setSaved(false); setWindows((ws) => ws.filter((x) => x.key !== w.key)) }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-5 flex justify-end"><Button loading={busy} onClick={() => save(false)}>Save hours</Button></div>
      {confirm !== null && (
        <Modal title="Some appointments will need rebooking" onClose={() => setConfirm(null)}>
          <p className="text-ink-soft"><strong>{confirm}</strong> booked appointment{confirm === 1 ? '' : 's'} no longer fit{confirm === 1 ? 's' : ''} these hours. Those patients will be asked to pick a new time. Continue?</p>
          <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirm(null)}>Go back</Button><Button loading={busy} onClick={() => save(true)}>Save anyway</Button></div>
        </Modal>
      )}
    </section>
  )
}

function LeavePanel({ leaves, onChanged }) {
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)

  async function add(apply) {
    setBusy(true); setError('')
    try {
      if (!apply) {
        const p = await api('/doctor/leaves?preview=1', { method: 'POST', body: { date, reason } })
        if (p.movedToRebooking > 0) { setConfirm(p.movedToRebooking); setBusy(false); return }
      }
      await api('/doctor/leaves', { method: 'POST', body: { date, reason } })
      setDate(''); setReason(''); setConfirm(null); onChanged()
    } catch (e) { setError(e.message); setConfirm(null) } finally { setBusy(false) }
  }
  return (
    <section className="card h-fit p-6" aria-labelledby="leave-h">
      <h2 id="leave-h" className="text-lg font-semibold">Leave dates</h2>
      <p className="mb-4 text-sm text-ink-soft">Block a day so nobody can book it.</p>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); add(false) }} className="space-y-3">
        <Field label="Date">{(id) => <Input id={id} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Button type="submit" loading={busy} className="w-full">Block this day</Button>
      </form>
      <ul className="mt-5 divide-y divide-slate-100">
        {leaves.length === 0 && <li className="py-3 text-sm text-ink-muted">No upcoming leave.</li>}
        {leaves.map((l) => (
          <li key={l.id} className="flex items-center justify-between py-2.5 text-sm">
            <span><strong>{l.date}</strong>{l.reason && <span className="text-ink-soft"> · {l.reason}</span>}</span>
            <Button size="sm" variant="ghost" onClick={async () => { await api(`/doctor/leaves/${l.id}`, { method: 'DELETE' }); onChanged() }}>Remove</Button>
          </li>
        ))}
      </ul>
      {confirm !== null && (
        <Modal title="Some appointments will need rebooking" onClose={() => setConfirm(null)}>
          <p className="text-ink-soft"><strong>{confirm}</strong> booked appointment{confirm === 1 ? '' : 's'} fall{confirm === 1 ? 's' : ''} on {date}. Those patients will be asked to pick a new time. Continue?</p>
          <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirm(null)}>Go back</Button><Button loading={busy} onClick={() => add(true)}>Block the day</Button></div>
        </Modal>
      )}
    </section>
  )
}
