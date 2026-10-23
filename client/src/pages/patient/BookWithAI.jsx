import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { saveAiReason } from '../../lib/aiBooking.js'
import { Alert, Button } from '../../components/ui.jsx'

const MAX = 500
const EXAMPLE = 'I have a skin rash and itching. Can I see someone tomorrow morning?'
const URGENCY = { routine: ['Routine', 'bg-slate-100 text-slate-700'], soon: ['Should be seen soon', 'bg-accent-100 text-amber-900'] }

function Emergency() {
  return (
    <Alert tone="error" className="!p-5" data-testid="emergency">
      <p className="text-lg font-bold">If this is an emergency, call 108 now.</p>
      <p className="mt-1">Please do not wait for an appointment.</p>
    </Alert>
  )
}

function Suggestion({ s, text, onBook }) {
  if (s.emergency) return <Emergency />
  const [urgency, tone] = URGENCY[s.urgency] || URGENCY.routine
  const p = s.preferred || {}
  return (
    <div className="space-y-3" data-testid="suggestion">
      {s.department ? (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <span>Suggested department:</span> <strong className="text-lg text-brand-800" data-testid="department">{s.department.name}</strong>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{urgency}</span>
          </p>
          {s.reason && <p className="text-sm text-ink-soft">{s.reason}</p>}
          <p className="text-xs text-ink-muted">{s.path === 'ai' ? 'Suggested by AI.' : 'Suggested from the words you used (simple keyword rules), because the AI was not available.'}</p>
          {s.urgency === 'soon' && <Alert tone="warn">This sounds like it should be seen soon. Pick the earliest slot below. If it gets worse, call 108.</Alert>}
          {p.matched === 'partial' && <p className="text-sm text-ink-soft">There is no free slot at that time of day, so these are the free slots on that date.</p>}
          {p.matched === 'none' && <p className="text-sm text-ink-soft">No free slot matched the day or time you asked for, so these are the next available.</p>}
          {s.options.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-3" aria-label="Free slots">
              {s.options.map((o) => (
                <li key={`${o.doctorId}-${o.startUtc}`} className="card p-4" data-testid="option">
                  <p className="font-semibold">{o.doctorName}</p>
                  <p className="text-xs text-ink-muted">{o.department}</p>
                  <p className="mt-2 text-sm"><span className="font-semibold">{o.dateIst}</span><br />{o.timeIst} IST</p>
                  <Button size="sm" variant="accent" className="mt-3 w-full" onClick={() => onBook(o, text)}>Book this slot</Button>
                </li>
              ))}
            </ul>
          ) : (
            <Alert tone="info">There are no free slots in {s.department.name} right now. <Link to={`/doctors?department=${s.department.id}`} className="font-semibold underline">See its doctors</Link> or try again later.</Alert>
          )}
        </>
      ) : (
        <>
          <p>We could not tell which department fits. Please choose one, or look for a doctor yourself:</p>
          <div className="flex flex-wrap gap-2" data-testid="all-departments">
            {s.departments.map((d) => <Link key={d.id} to={`/doctors?department=${d.id}`} className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium hover:border-brand-400 hover:bg-brand-50">{d.name}</Link>)}
          </div>
          <Link to="/doctors" className="inline-block text-sm font-semibold text-brand-700 underline">Find a doctor</Link>
        </>
      )}
      <p className="text-xs text-ink-muted">This suggests a department. It is not a diagnosis.</p>
    </div>
  )
}

export default function BookWithAI() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [turns, setTurns] = useState([]) // { id, text, state: 'loading' | 'done' | 'error', suggestion, error, limited }
  const [busy, setBusy] = useState(false)
  const end = useRef(null)
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }) }, [turns])

  async function send(e) {
    e?.preventDefault()
    const t = text.trim()
    if (t.length < 3 || busy) return
    const id = Date.now()
    setTurns((x) => [...x, { id, text: t, state: 'loading' }])
    setText(''); setBusy(true)
    try {
      const r = await api('/patient/book-with-ai', { method: 'POST', body: { text: t } })
      setTurns((x) => x.map((y) => (y.id === id ? { ...y, state: 'done', suggestion: r.suggestion } : y)))
    } catch (err) {
      setTurns((x) => x.map((y) => (y.id === id ? { ...y, state: 'error', error: err.message, limited: err.status === 429 } : y)))
    } finally { setBusy(false) }
  }
  const book = (o, original) => {
    saveAiReason(o.doctorId, o.startUtc, original)
    navigate(`/book?doctor=${o.doctorId}&slot=${o.startUtc}`)
  }
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  return (
    <div className="mx-auto flex max-w-3xl flex-col px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Book with AI</h1>
      <p className="mt-1 text-ink-soft">Tell us what you need in your own words. We suggest a department and show real free slots. You confirm the booking yourself.</p>
      <p className="mt-3 rounded-xl bg-sky-50 px-4 py-2.5 text-sm text-sky-900" data-testid="ai-note">This suggests a department. It is not a diagnosis.</p>

      <section className="mt-6 space-y-4" aria-label="Conversation" aria-live="polite">
        <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white p-4 shadow-card"><p>Hello! What do you need help with?</p><p className="mt-1 text-sm text-ink-muted">For example: “{EXAMPLE}”</p></div>
        {turns.map((t) => (
          <div key={t.id} className="space-y-3">
            <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-700 p-4 text-white">{t.text}</div>
            <div className="max-w-full rounded-2xl rounded-tl-sm bg-white p-4 shadow-card">
              {t.state === 'loading' && <p className="flex items-center gap-2 text-ink-soft"><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden="true" /> Thinking…</p>}
              {t.state === 'error' && <Alert tone={t.limited ? 'warn' : 'error'}>{t.error}{t.limited && <> <Link to="/doctors" className="font-semibold underline">Find a doctor</Link></>}</Alert>}
              {t.state === 'done' && <Suggestion s={t.suggestion} text={t.text} onBook={book} />}
            </div>
          </div>
        ))}
        <div ref={end} />
      </section>

      <form onSubmit={send} className="sticky bottom-4 mt-6 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg">
        <label htmlFor="ai-text" className="sr-only">Describe what you need</label>
        <textarea id="ai-text" rows={3} maxLength={MAX} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Describe what you need, and a day or time if you like" className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500" />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-ink-muted"><span data-testid="counter">{text.length}/{MAX}</span> · Please do not put names or phone numbers here. For an emergency call 108.</p>
          <Button type="submit" loading={busy} disabled={text.trim().length < 3}>Send</Button>
        </div>
      </form>
    </div>
  )
}
