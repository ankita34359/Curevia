import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { Alert, Avatar, Button, Field, Input, Select, Skeleton, Textarea, useLoad } from '../../components/ui.jsx'
import { DoctorCard, DoctorCardSkeleton } from '../../components/DoctorCard.jsx'
import { SlotPicker } from '../../components/SlotPicker.jsx'
import { iconFor, rupees } from '../../lib/format.js'

const STEPS = ['Choose doctor', 'Pick a slot', 'Your details']

function Progress({ step }) {
  return (
    <ol className="mb-8 flex items-center" aria-label="Booking progress">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = step > n
        const current = step === n
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none" aria-current={current ? 'step' : undefined}>
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-all duration-300 ${done ? 'bg-brand-700 text-white' : current ? 'bg-brand-700 text-white ring-4 ring-brand-100' : 'bg-slate-200 text-ink-muted'}`}>{done ? '✓' : n}</span>
            <span className={`ml-2 whitespace-nowrap text-sm font-semibold ${current || done ? 'text-ink' : 'text-ink-muted'}`}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-4 h-1 flex-1 overflow-hidden rounded-full bg-slate-200"><span className={`block h-full bg-brand-600 transition-all duration-500 ${done ? 'w-full' : 'w-0'}`} /></span>}
          </li>
        )
      })}
    </ol>
  )
}

function Summary({ doctor, slot, step }) {
  return (
    <aside className="card sticky top-24 h-fit p-6" aria-label="Booking summary">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Booking summary</h2>
      {!doctor ? <p className="mt-4 text-sm text-ink-soft">Choose a doctor to begin.</p> : (
        <div className="mt-4 animate-fade-up space-y-4">
          <div className="flex items-center gap-3"><Avatar name={doctor.name} photoUrl={doctor.photoUrl} size={52} /><div><p className="font-semibold">{doctor.name}</p><p className="text-sm text-brand-700">{doctor.department}</p></div></div>
          <dl className="space-y-3 border-t border-slate-100 pt-4 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Date</dt><dd className="font-semibold">{slot ? slot.dateIst : step >= 2 ? 'Pick a slot' : '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Time (IST)</dt><dd className="font-semibold">{slot ? slot.timeIst : '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Consultation fee</dt><dd className="font-semibold">{rupees(doctor.fee)}</dd></div>
          </dl>
          <p className="rounded-xl bg-accent-50 px-3 py-2 text-xs text-amber-900">Your booking is a request. It stays <strong>pending</strong> until the doctor confirms, and we email you either way.</p>
        </div>
      )}
    </aside>
  )
}

export default function Book() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const doctorId = Number(params.get('doctor')) || null
  const slotParam = params.get('slot') || ''
  const [slot, setSlot] = useState(null) // { startUtc, dateIst, timeIst }
  const [step, setStep] = useState(doctorId ? (slotParam ? 3 : 2) : 1)
  const [department, setDepartment] = useState('')
  const [booked, setBooked] = useState(null)

  const doctors = useLoad(() => api(`/public/doctors${department ? `?department=${department}` : ''}`), [department])
  const deps = useLoad(() => api('/public/departments'))
  const doctor = useLoad(() => (doctorId ? api(`/public/doctors/${doctorId}`).then((r) => r.doctor) : Promise.resolve(null)), [doctorId])

  // Restore a slot passed in the URL (e.g. after signing in).
  useEffect(() => {
    if (slotParam && !slot) {
      const d = new Date(slotParam)
      if (!Number.isNaN(d.getTime())) {
        api(`/public/doctors/${doctorId}/slots?from=${new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10)}`).then((w) => {
          const s = w.days.flatMap((x) => x.slots).find((x) => x.startUtc === slotParam && x.state === 'free')
          const day = w.days.find((x) => x.slots.some((y) => y.startUtc === slotParam))
          if (s) setSlot({ startUtc: s.startUtc, timeIst: s.timeIst, dateIst: `${day.dayOfMonth} ${day.month} ${day.date.slice(0, 4)}` })
          else { setStep(2); setParams({ doctor: String(doctorId) }, { replace: true }) }
        }).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotParam])

  const chooseDoctor = (d) => { setSlot(null); setParams({ doctor: String(d.id) }, { replace: true }); setStep(2) }
  const chooseSlot = (s) => { setSlot(s); setParams({ doctor: String(doctorId), slot: s.startUtc }, { replace: true }) }

  if (booked) return <Success appointment={booked} doctor={doctor.data} />

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Book an appointment</h1>
      <p className="mb-8 mt-1 text-ink-soft">Three quick steps. Times are in India time (IST).</p>
      <Progress step={step} />
      <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
        <section aria-live="polite">
          {step === 1 && (
            <div className="animate-fade-up">
              <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Departments">
                <button aria-pressed={!department} onClick={() => setDepartment('')} className={`rounded-full border px-4 py-1.5 text-sm font-medium ${!department ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white hover:bg-brand-50'}`}>All</button>
                {deps.data?.departments.map((d) => <button key={d.id} aria-pressed={department === String(d.id)} onClick={() => setDepartment(String(d.id))} className={`rounded-full border px-4 py-1.5 text-sm font-medium ${department === String(d.id) ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white hover:bg-brand-50'}`}><span aria-hidden="true">{iconFor(d.icon)}</span> {d.name}</button>)}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {doctors.loading && [0, 1].map((i) => <DoctorCardSkeleton key={i} />)}
                {doctors.data?.doctors.map((d, i) => <DoctorCard key={d.id} doctor={d} index={i} selected={d.id === doctorId} onSelect={chooseDoctor} />)}
              </div>
              {doctors.data?.doctors.length === 0 && <p className="rounded-xl bg-white p-6 text-center text-ink-soft">No doctors in this department yet.</p>}
            </div>
          )}
          {step === 2 && doctorId && (
            <div className="card animate-fade-up p-6">
              <h2 className="text-lg font-semibold">Pick a date and time</h2>
              <div className="mt-5"><SlotPicker doctorId={doctorId} value={slot?.startUtc} onChange={(s) => chooseSlot(s)} /></div>
              <div className="mt-8 flex justify-between">
                <Button variant="secondary" onClick={() => setStep(1)}>← Change doctor</Button>
                <Button disabled={!slot} onClick={() => setStep(3)}>Continue →</Button>
              </div>
            </div>
          )}
          {step === 3 && doctor.data && slot && (
            <Details doctor={doctor.data} slot={slot} user={user} onBack={() => setStep(2)} onBooked={setBooked}
              onTaken={() => { setSlot(null); setParams({ doctor: String(doctorId) }, { replace: true }); setStep(2) }} navigate={navigate} />
          )}
          {step === 3 && !slot && <Skeleton className="h-64" />}
        </section>
        <Summary doctor={doctor.data} slot={slot} step={step} />
      </div>
    </div>
  )
}

function Details({ doctor, slot, user, onBack, onBooked, onTaken }) {
  const [f, setF] = useState({ name: user?.name || '', age: '', gender: '', phone: '', email: user?.email || '', reason: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const next = encodeURIComponent(`/book?doctor=${doctor.id}&slot=${slot.startUtc}`)
  const canBook = user?.role === 'patient' && user.emailVerified

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res = await api('/patient/appointments', { method: 'POST', body: { doctorId: doctor.id, startUtc: slot.startUtc, name: f.name, age: Number(f.age), gender: f.gender, phone: f.phone, email: f.email, reason: f.reason } })
      onBooked(res.appointment)
    } catch (err) {
      setError(err.message)
      if (err.body?.code === 'slot_taken') setTimeout(onTaken, 1800)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="card animate-fade-up p-6">
      <h2 className="text-lg font-semibold">Your details</h2>
      {!user && <Alert tone="info" className="mt-4">Please <Link className="font-semibold underline" to={`/login?next=${next}`}>sign in</Link> or <Link className="font-semibold underline" to={`/signup?next=${next}`}>create an account</Link> to finish booking. Your chosen doctor and time will be waiting.</Alert>}
      {user && user.role !== 'patient' && <Alert tone="warn" className="mt-4">Only patient accounts can book appointments.</Alert>}
      {user?.role === 'patient' && !user.emailVerified && <Alert tone="warn" className="mt-4">Please verify your email first. We sent you a link when you signed up. (Use "Send it again" at the top of the page if you need a new one.)</Alert>}
      {error && <Alert tone="error" className="mt-4">{error}</Alert>}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Patient's full name">{(id) => <Input id={id} required minLength={2} maxLength={100} autoComplete="name" value={f.name} onChange={set('name')} />}</Field>
        <Field label="Age">{(id) => <Input id={id} type="number" required min="0" max="120" value={f.age} onChange={set('age')} />}</Field>
        <Field label="Gender">{(id) => <Select id={id} required value={f.gender} onChange={set('gender')}><option value="" disabled>Choose…</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select>}</Field>
        <Field label="Phone number">{(id) => <Input id={id} type="tel" required autoComplete="tel" placeholder="+91 98765 43210" value={f.phone} onChange={set('phone')} />}</Field>
        <div className="md:col-span-2"><Field label="Email" hint="Confirmations and reminders are sent here">{(id) => <Input id={id} type="email" required autoComplete="email" value={f.email} onChange={set('email')} />}</Field></div>
        <div className="md:col-span-2"><Field label="Reason for visit" hint="A short note for the doctor">{(id) => <Textarea id={id} required minLength={3} maxLength={500} value={f.reason} onChange={set('reason')} />}</Field></div>
      </div>
      <div className="mt-8 flex justify-between">
        <Button type="button" variant="secondary" onClick={onBack}>← Change time</Button>
        <Button type="submit" variant="accent" size="lg" loading={busy} disabled={!canBook}>Request appointment</Button>
      </div>
    </form>
  )
}

function Success({ appointment: a }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <div className="mx-auto flex h-20 w-20 animate-fade-up items-center justify-center rounded-full bg-brand-100 text-4xl text-brand-700 shadow-lg" aria-hidden="true">✓</div>
      <h1 className="mt-6 animate-fade-up text-3xl font-bold" style={{ animationDelay: '80ms' }}>Request received</h1>
      <p className="mt-2 animate-fade-up text-ink-soft" style={{ animationDelay: '140ms' }}>{a.doctorName} will confirm your appointment soon. We'll email you as soon as they do.</p>
      <div className="card mx-auto mt-8 animate-fade-up p-6 text-left" style={{ animationDelay: '200ms' }}>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-ink-muted">Doctor</dt><dd className="font-semibold">{a.doctorName}</dd></div>
          <div><dt className="text-ink-muted">Department</dt><dd className="font-semibold">{a.department}</dd></div>
          <div><dt className="text-ink-muted">When (IST)</dt><dd className="font-semibold">{a.startIst}</dd></div>
          <div><dt className="text-ink-muted">Status</dt><dd className="font-semibold">Pending doctor's confirmation</dd></div>
        </dl>
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <a href={`/api/patient/appointments/${a.id}/calendar.ics`}><Button variant="secondary">Add to calendar</Button></a>
        <Link to="/my"><Button>View my appointments</Button></Link>
      </div>
    </div>
  )
}
