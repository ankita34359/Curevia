import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, EmptyState, PageHeader, Select, Skeleton, useLoad } from '../../components/ui.jsx'
import { RatingBadge, Stars } from '../../components/Rating.jsx'

const CATEGORY = {
  praise: ['Praise', 'bg-emerald-100 text-emerald-900'],
  suggestion: ['Suggestion', 'bg-sky-100 text-sky-900'],
  complaint: ['Complaint', 'bg-orange-100 text-orange-900'],
  urgent: ['Urgent', 'bg-red-100 text-red-800'],
  unsorted: ['Unsorted', 'bg-slate-200 text-slate-700']
}
const SOURCE = { ai: ['AI', 'bg-violet-100 text-violet-900'], rule: ['Rule', 'bg-accent-100 text-amber-900'] }

export default function AdminFeedback() {
  const [category, setCategory] = useState('')
  const [doctorId, setDoctorId] = useState('')
  const qs = new URLSearchParams({ ...(category && { category }), ...(doctorId && { doctorId }) }).toString()
  const data = useLoad(() => api(`/admin/feedback?${qs}`), [qs])
  // The doctor list for the filter comes from the same call (averages), so it stays complete when a filter is on.
  const d = data.data
  return (
    <div>
      <PageHeader title="Feedback" subtitle="What patients said after their visit, sorted by the AI. Complaints and urgent ones also go to Slack." />
      {data.error && <Alert tone="error" className="mb-4">{data.error}</Alert>}

      <h2 className="mb-3 text-lg font-semibold">Average rating per doctor</h2>
      {data.loading && !d ? <Skeleton className="h-24" /> : (
        <div className="card mb-8 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted"><tr>{['Doctor', 'Department', 'Average', 'Ratings'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100" data-testid="averages">
              {d?.perDoctor.map((x) => (
                <tr key={x.doctorId}>
                  <td className="px-4 py-3 font-medium">{x.name}</td>
                  <td className="px-4 py-3 text-ink-soft">{x.department}</td>
                  <td className="px-4 py-3">{x.count ? <span className="inline-flex items-center gap-2"><Stars value={x.average} /><span className="font-semibold tabular-nums">{x.average.toFixed(1)}</span></span> : <span className="text-ink-muted">No feedback yet</span>}</td>
                  <td className="px-4 py-3 tabular-nums">{x.count}</td>
                </tr>
              ))}
              {d && d.overall.count > 0 && (
                <tr className="bg-slate-50/70 font-semibold"><td className="px-4 py-3" colSpan={2}>All doctors</td><td className="px-4 py-3"><RatingBadge avg={d.overall.average} count={d.overall.count} /></td><td className="px-4 py-3 tabular-nums">{d.overall.count}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">All feedback</h2>
        <div className="flex gap-2">
          <Select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)} className="!w-auto">
            <option value="">All categories</option>
            {Object.entries(CATEGORY).map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </Select>
          <Select aria-label="Filter by doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="!w-auto">
            <option value="">All doctors</option>
            {d?.perDoctor.map((x) => <option key={x.doctorId} value={x.doctorId}>{x.name}</option>)}
          </Select>
        </div>
      </div>

      {data.loading && !d ? <Skeleton className="h-40" /> : d?.feedback.length === 0 ? (
        <EmptyState title="No feedback matches" icon="⭐">Feedback appears here after patients answer the email they get when a visit is completed.</EmptyState>
      ) : (
        <ol className="space-y-3" data-testid="feedback-list">
          {d?.feedback.map((f, i) => {
            const [label, tone] = CATEGORY[f.category || 'unsorted']
            const [src, srcTone] = SOURCE[f.categorySource] || ['Pending', 'bg-slate-100 text-slate-600']
            return (
              <li key={f.id} className="card animate-fade-up p-4" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
                    <span className="inline-flex items-center gap-1.5"><Stars value={f.rating} className="text-lg" /><span className="tabular-nums">{f.rating}/5</span></span>
                    <span>{f.doctorName} <span className="font-normal text-ink-muted">· {f.department}</span></span>
                  </p>
                  <p className="flex items-center gap-2 text-xs text-ink-muted">
                    <span className={`rounded-full px-2.5 py-0.5 font-semibold ${tone}`} data-testid="category-badge">{f.sorted ? label : 'Sorting…'}</span>
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${srcTone}`} title={f.categorySource === 'ai' ? 'Sorted by the AI' : f.categorySource === 'rule' ? 'The AI was unavailable: sorted by the rating rule' : 'Not sorted yet'}>{src}</span>
                    {f.atIst}
                  </p>
                </div>
                {f.comment ? <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm">“{f.comment}”</p> : <p className="mt-2 text-sm text-ink-muted">No comment.</p>}
                {f.summary && <p className="mt-2 text-sm"><strong>Summary:</strong> {f.summary}</p>}
                {f.reason && <p className="mt-1 text-sm text-ink-soft"><strong>Why:</strong> {f.reason}</p>}
                {f.aiError && <p className="mt-1 text-xs text-orange-800">The AI was not used: {f.aiError}</p>}
                <p className="mt-2 text-xs text-ink-muted">Visit {f.visitIst} · appointment #{f.appointmentId}</p>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
