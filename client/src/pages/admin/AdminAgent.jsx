import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Button, EmptyState, PageHeader, Skeleton, useLoad } from '../../components/ui.jsx'

const ACTION = {
  remind_doctor: ['Reminded the doctor', '📧'], alert_admin: ['Alerted the admin', '🚨'], offer_slots_to_patient: ['Offered slots to the patient', '🗓️'],
  remind_patient: ['Reminded the patient', '📧'], wait: ['Waited', '⏳'], close_case: ['Closed the case', '✅'],
  hold_quiet_hours: ['Held for quiet hours', '🌙'], expire_request: ['Expired the request', '⌛']
}
const SOURCE = { ai: ['AI', 'bg-sky-100 text-sky-900'], fallback: ['Fixed rules', 'bg-accent-100 text-amber-900'], guard: ['Safety rule', 'bg-slate-200 text-slate-800'] }
const CASE = { pending: 'Waiting for doctor', needs_rebooking: 'Needs a new slot' }

export default function AdminAgent() {
  const data = useLoad(() => api('/admin/agent'))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function checkNow() {
    setRunning(true); setError(''); setResult(null)
    try { setResult((await api('/admin/agent/check-now', { method: 'POST' })).result); data.reload() } catch (e) { setError(e.message) } finally { setRunning(false) }
  }
  const d = data.data
  return (
    <div>
      <PageHeader title="Agent activity" subtitle="The agent watches stuck bookings and decides one next step at a time. It runs every 5 minutes." actions={<Button loading={running} onClick={checkNow}>Check now</Button>} />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {result && (
        <Alert tone="success" className="mb-4">
          {result.skipped ? 'A check was already running.' : `Checked ${result.agent.cases} case${result.agent.cases === 1 ? '' : 's'}: ${result.agent.actions} action${result.agent.actions === 1 ? '' : 's'} taken${result.agent.waits ? `, ${result.agent.waits} set to wait or held for quiet hours (the reason and next step are listed below)` : ''}${result.agent.expired ? `, ${result.agent.expired} expired request${result.agent.expired === 1 ? '' : 's'} closed` : ''}${result.agent.notDue ? `, ${result.agent.notDue} not due for another look yet` : ''}${result.agent.notDelivered ? `, ${result.agent.notDelivered} could not be delivered (see below)` : ''}${result.agent.fallbacks ? `, ${result.agent.fallbacks} decided by fixed rules because the AI was unavailable` : ''}. Reminders sent: ${result.reminders.sent}.`}
        </Alert>
      )}
      {d?.demoMinutes && (
        <p className="mb-4 inline-flex flex-wrap items-center gap-2 rounded-full bg-violet-100 px-3 py-1 text-sm font-semibold text-violet-900" data-testid="demo-badge">
          <span aria-hidden="true">⏱️</span> Demo timing on
          <span className="font-normal">· doctor reminder after {d.demoMinutes} min, admin alert after {d.demoMinutes * 3} min (instead of 2 and 6 hours)</span>
        </p>
      )}
      {d?.aiBooking && (
        <p className="mb-4 rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700" data-testid="ai-booking-count"><span aria-hidden="true">✨</span> <strong>AI booking suggestions</strong> (Book with AI): {d.aiBooking.ai} by the AI · {d.aiBooking.fallback} by keyword rules</p>
      )}
      {d?.quietHours?.enabled && (
        <p className={`mb-4 rounded-xl px-3 py-2 text-sm ${d.quietHours.activeNow ? 'bg-indigo-100 text-indigo-900' : 'bg-slate-100 text-slate-700'}`} data-testid="quiet-hours">
          <span aria-hidden="true">🌙</span> <strong>{d.quietHours.activeNow ? `Quiet hours now · emails wait until ${d.quietHours.resumeAtIst}` : 'Quiet hours: 10 PM to 8 AM IST'}</strong>
          <span> · The agent sends no patient or doctor email in that time and holds it until 8 AM, unless the appointment is less than 2 hours away. Slack alerts to the admin go any time.</span>
        </p>
      )}
      {d && !d.aiConfigured && <Alert tone="warn" className="mb-4">viaSocket is not connected yet, so the agent uses its fixed rules, and emails and alerts are not sent.</Alert>}

      <h2 className="mb-3 text-lg font-semibold">Open cases</h2>
      {data.loading ? <Skeleton className="h-32" /> : d.openCases.length === 0 ? (
        <EmptyState title="No stuck bookings" icon="🎉">Nothing needs the agent right now. Requests waiting for a doctor and appointments that need a new slot show up here.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>{['Case', 'Appointment', 'Open since', 'Done so far', 'Next check', 'Last decision'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {d.openCases.map((c) => (
                <tr key={`${c.appointmentId}${c.caseType}`}>
                  <td className="px-4 py-3"><span className="rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-semibold text-orange-900">{CASE[c.caseType]}</span><p className="mt-1 text-xs text-ink-muted">#{c.appointmentId}</p></td>
                  <td className="px-4 py-3"><p className="font-medium">{c.doctor}</p><p className="text-xs text-ink-muted">{c.department} · {c.whenIst}</p></td>
                  <td className="whitespace-nowrap px-4 py-3">{c.openSince}</td>
                  <td className="px-4 py-3 text-xs">Doctor reminders {c.done.doctorReminders}/2<br />Patient reminders {c.done.patientReminders}/2<br />Slot offers {c.done.offers}/{d.maxOffers}<br />Admin {c.done.adminAlerted ? 'alerted' : 'not alerted'}</td>
                  <td className="whitespace-nowrap px-4 py-3">{c.nextCheckIst || 'next tick'}</td>
                  <td className="px-4 py-3">{c.lastDecision ? <><p className="font-medium">{c.lastDecision.executed ? '' : 'Not done: '}{ACTION[c.lastDecision.action]?.[0] || c.lastDecision.action}</p><p className="max-w-xs text-xs text-ink-soft">{c.lastDecision.reason}</p>{!c.lastDecision.executed && <p className="max-w-xs text-xs text-orange-800">{c.lastDecision.outcome}</p>}</> : <span className="text-ink-muted">Not looked at yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d?.notLookedAtYet > 0 && <p className="mt-2 text-sm text-ink-muted">{d.notLookedAtYet} more stuck booking{d.notLookedAtYet === 1 ? '' : 's'} will be looked at on the next check.</p>}

      <h2 className="mb-3 mt-10 text-lg font-semibold">Decisions and why</h2>
      {data.loading ? <Skeleton className="h-40" /> : d.decisions.length === 0 ? <EmptyState title="No decisions yet" icon="🧭">When the agent acts, each decision and its reason is listed here.</EmptyState> : (
        <ol className="space-y-3">
          {d.decisions.map((x, i) => {
            const [label, icon] = ACTION[x.action] || [x.action, '•']
            const [src, tone] = SOURCE[x.source]
            return (
              <li key={x.id} className="card animate-fade-up p-4" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold"><span aria-hidden="true">{icon}</span> {x.executed ? label : `Not done: ${label.toLowerCase()}`} <span className="font-normal text-ink-muted">· appointment #{x.appointmentId} · {CASE[x.caseType]}</span></p>
                  <p className="flex items-center gap-2 text-xs text-ink-muted"><span className={`rounded-full px-2 py-0.5 font-semibold ${tone}`}>{src}</span>{x.atIst}</p>
                </div>
                <p className="mt-1 text-sm text-ink-soft"><strong>Why:</strong> {x.reason}</p>
                <p className="mt-1 text-xs text-ink-muted"><strong>Result:</strong> {x.outcome}</p>
                {x.params?.slots && <p className="mt-1 text-xs text-ink-muted">Slots offered: {x.params.slots.join('; ')}</p>}
                {x.action === 'hold_quiet_hours' && x.params?.resumeAtIst && <p className="mt-1 text-xs text-ink-muted">Decided again at: {x.params.resumeAtIst} · held step: {x.params.heldAction?.replace(/_/g, ' ')} · chosen by {x.params.chosenBy === 'ai' ? 'the AI' : 'the fixed rules'}</p>}
                {x.action === 'wait' && x.params?.nextCheckAtIst && <p className="mt-1 text-xs text-ink-muted">Next check: {x.params.nextCheckAtIst}{x.params.nextStep ? ` · next step: ${x.params.nextStep.label} at ${x.params.nextStep.atIst}` : ''}</p>}
                {x.aiError && <p className="mt-1 text-xs text-orange-800">The AI was not used: {x.aiError}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
