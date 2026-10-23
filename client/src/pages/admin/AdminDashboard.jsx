import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Button, EmptyState, PageHeader, Select, Skeleton, StatusBadge, useLoad } from '../../components/ui.jsx'

const CARDS = [
  { key: 'today', label: 'Today', hint: 'Appointments scheduled today', tone: 'from-brand-50 to-white' },
  { key: 'pending', label: 'Pending', hint: 'Waiting for a doctor to confirm', tone: 'from-accent-50 to-white' },
  { key: 'confirmed', label: 'Confirmed', hint: 'Confirmed by a doctor', tone: 'from-sky-50 to-white' },
  { key: 'cancelled', label: 'Cancelled', hint: 'By patients or doctors', tone: 'from-red-50 to-white' },
  { key: 'needsRebooking', label: 'Needs rebooking', hint: 'Waiting for a new slot', tone: 'from-orange-50 to-white' }
]
const STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled_by_patient', 'cancelled_by_doctor', 'needs_rebooking', 'rebooked', 'expired']

export default function AdminDashboard() {
  const dash = useLoad(() => api('/admin/dashboard'))
  const [status, setStatus] = useState('')
  const [doctorId, setDoctorId] = useState('')
  const qs = new URLSearchParams({ ...(status && { status }), ...(doctorId && { doctorId }) }).toString()
  const list = useLoad(() => api(`/admin/appointments?${qs}`), [qs])

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="How bookings are going across the hospital."
        actions={<a href={`/api/admin/appointments.csv?${qs}`} download><Button variant="secondary">Download CSV</Button></a>}
      />
      {dash.error && <Alert tone="error">{dash.error}</Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {CARDS.map((c, i) => (
          <div key={c.key} className={`card animate-fade-up bg-gradient-to-br p-5 transition hover:-translate-y-0.5 hover:shadow-lg ${c.tone}`} style={{ animationDelay: `${i * 60}ms` }}>
            <p className="text-sm font-medium text-ink-soft">{c.label}</p>
            {dash.loading ? <Skeleton className="mt-2 h-9 w-14" /> : <p className="mt-1 text-4xl font-bold tabular-nums">{dash.data.cards[c.key]}</p>}
            <p className="mt-1 text-xs text-ink-muted">{c.hint}</p>
          </div>
        ))}
      </div>

      <h2 className="mb-3 mt-10 text-lg font-semibold">Bookings per doctor</h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
            <tr>{['Doctor', 'Department', 'Total', 'Pending', 'Confirmed', 'Completed', 'Cancelled', 'Needs rebooking'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dash.loading && [0, 1, 2].map((i) => <tr key={i}><td colSpan={8} className="px-4 py-3"><Skeleton className="h-5" /></td></tr>)}
            {dash.data?.perDoctor.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50/70">
                <td className="px-4 py-3 font-medium">{d.name}{!d.active && <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs">inactive</span>}</td>
                <td className="px-4 py-3 text-ink-soft">{d.department}</td>
                <td className="px-4 py-3 tabular-nums">{d.total}</td><td className="px-4 py-3 tabular-nums">{d.pending}</td>
                <td className="px-4 py-3 tabular-nums">{d.confirmed}</td><td className="px-4 py-3 tabular-nums">{d.completed}</td>
                <td className="px-4 py-3 tabular-nums">{d.cancelled}</td><td className="px-4 py-3 tabular-nums">{d.needsRebooking}</td>
              </tr>
            ))}
            {dash.data?.perDoctor.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-ink-muted">No doctors yet. Add one on the Doctors page.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mb-3 mt-10 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">Appointments</h2>
        <div className="flex gap-2">
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto">
            <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </Select>
          <Select aria-label="Filter by doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="!w-auto">
            <option value="">All doctors</option>{dash.data?.perDoctor.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
      </div>
      {list.loading ? <Skeleton className="h-40" /> : list.data.appointments.length === 0 ? (
        <EmptyState title="No appointments match">Bookings will show up here as soon as patients make them.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>{['When (IST)', 'Patient', 'Doctor', 'Department', 'Status'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.appointments.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50/70">
                  <td className="whitespace-nowrap px-4 py-3">{a.startIst}</td><td className="px-4 py-3">{a.patientName}</td>
                  <td className="px-4 py-3">{a.doctorName}</td><td className="px-4 py-3 text-ink-soft">{a.department}</td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
