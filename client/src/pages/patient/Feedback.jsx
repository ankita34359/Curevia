import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api.js'
import { Alert, Button, EmptyState, Field, Skeleton, Textarea } from '../../components/ui.jsx'

const WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent']

function StarPicker({ value, onChange }) {
  const [hover, setHover] = useState(0)
  const shown = hover || value
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Your rating</legend>
      <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer" onMouseEnter={() => setHover(n)}>
            <input type="radio" name="rating" value={n} checked={value === n} onChange={() => onChange(n)} className="peer sr-only" />
            <span aria-hidden="true" className={`block rounded-lg p-0.5 text-4xl leading-none transition peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600 ${n <= shown ? 'text-amber-500' : 'text-slate-300'}`}>★</span>
            <span className="sr-only">{n} {n === 1 ? 'star' : 'stars'}: {WORDS[n]}</span>
          </label>
        ))}
        <span className="ml-3 text-sm text-ink-soft" aria-live="polite">{shown ? WORDS[shown] : 'Tap a star'}</span>
      </div>
    </fieldset>
  )
}

function Emergency() {
  return <Alert tone="error" className="mt-5"><strong>If this is an emergency, call 108 now.</strong></Alert>
}

function Thanks({ already, urgent, signedIn }) {
  return (
    <div className="card animate-fade-up p-8 text-center" data-testid="feedback-thanks">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-3xl text-brand-700" aria-hidden="true">✓</div>
      <h1 className="mt-5 text-2xl font-bold tracking-tight">{already ? 'We already have your feedback' : 'Thank you for your feedback'}</h1>
      <p className="mt-2 text-ink-soft">{already ? 'Feedback can be sent once for each visit. Thank you for taking the time.' : 'It helps us look after every patient better.'}</p>
      {urgent && <div className="text-left"><Emergency /></div>}
      <Link to={signedIn ? '/my' : '/'} className="mt-6 inline-block"><Button variant="secondary">{signedIn ? 'Back to my appointments' : 'Back to Curevia'}</Button></Link>
    </div>
  )
}

// The form used by both pages: the emailed signed link (no sign-in) and Visit history (signed in).
function FeedbackForm({ base, signedIn }) {
  const [info, setInfo] = useState(null)
  const [problem, setProblem] = useState(null)
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)

  useEffect(() => {
    let live = true
    api(base).then((r) => live && setInfo(r.feedback)).catch((e) => live && setProblem(e))
    return () => { live = false }
  }, [base])

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await api(base, { method: 'POST', body: { rating, comment } })
      setDone({ urgent: r.urgent })
    } catch (err) {
      if (err instanceof ApiError && err.body?.code === 'already_submitted') setDone({ already: true })
      else { setError(err.message); setBusy(false) }
    }
  }

  const shell = (children) => <div className="mx-auto max-w-xl px-6 py-12">{children}</div>
  if (problem) {
    const expired = problem.status === 410
    return shell(<EmptyState title={expired ? 'This feedback link has expired' : problem.status === 404 || problem.status === 409 ? 'This feedback link is not valid' : 'Something went wrong'} icon="⭐">{expired ? 'Feedback links work for 30 days after the visit.' : problem.message}</EmptyState>)
  }
  if (!info) return shell(<Skeleton className="h-72" />)
  if (done) return shell(<Thanks already={done.already} urgent={done.urgent || (done.already && info.urgent)} signedIn={signedIn} />)
  if (info.submitted) return shell(<Thanks already urgent={info.urgent} signedIn={signedIn} />)
  return shell(
    <form onSubmit={submit} className="card animate-fade-up space-y-6 p-8" aria-labelledby="fb-h">
      <div>
        <h1 id="fb-h" className="text-2xl font-bold tracking-tight">How was your visit with {info.doctorName}?</h1>
        <p className="mt-1 text-sm text-ink-soft">{info.department} · visit on {info.visitDate}</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <StarPicker value={rating} onChange={setRating} />
      <Field label="Comment (optional)" hint="Please do not write test results or other private medical details here.">
        {(id) => <Textarea id={id} rows={4} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell us what went well, or what we could do better" />}
      </Field>
      <p className="-mt-4 text-right text-xs text-ink-muted" aria-live="off">{comment.length}/500</p>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">For a medical emergency call 108.</p>
        <Button type="submit" size="lg" disabled={!rating} loading={busy}>{busy ? 'Sending…' : 'Send feedback'}</Button>
      </div>
    </form>
  )
}

export function FeedbackByLink() {
  const { token } = useParams()
  return <FeedbackForm base={`/feedback/${encodeURIComponent(token)}`} signedIn={false} />
}
export function FeedbackSignedIn() {
  const { id } = useParams()
  return <FeedbackForm base={`/patient/appointments/${id}/feedback`} signedIn />
}
