import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { Button, EmptyState, Input, useLoad } from '../../components/ui.jsx'
import { DoctorCard, DoctorCardSkeleton } from '../../components/DoctorCard.jsx'
import { iconFor } from '../../lib/format.js'

export default function Doctors() {
  const [params, setParams] = useSearchParams()
  const { user } = useAuth()
  const q = params.get('q') || ''
  const department = params.get('department') || ''
  const [text, setText] = useState(q)
  useEffect(() => { setText(q) }, [q])
  const deps = useLoad(() => api('/public/departments'))
  const docs = useLoad(() => api(`/public/doctors?${new URLSearchParams({ ...(q && { q }), ...(department && { department }) })}`), [q, department])
  const setParam = (k, v) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n, { replace: true }) }

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Find a doctor</h1>
          <p className="mt-1 text-ink-soft">Choose a doctor to see their free slots.</p>
        </div>
        {user?.role === 'patient' && <Link to="/book-with-ai"><Button variant="accent" size="lg" data-testid="book-with-ai-button"><span aria-hidden="true">✨</span> Book with AI</Button></Link>}
      </div>
      <form role="search" onSubmit={(e) => { e.preventDefault(); setParam('q', text.trim()) }} className="mt-6 max-w-xl">
        <Input aria-label="Search by doctor or department" placeholder="Search by doctor or department" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setParam('q', text.trim())} />
      </form>
      <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Departments">
        <button aria-pressed={!department} onClick={() => setParam('department', '')} className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${!department ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white hover:bg-brand-50'}`}>All</button>
        {deps.data?.departments.map((d) => (
          <button key={d.id} aria-pressed={department === String(d.id)} onClick={() => setParam('department', String(d.id))} className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${department === String(d.id) ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white hover:bg-brand-50'}`}><span aria-hidden="true">{iconFor(d.icon)}</span> {d.name}</button>
        ))}
      </div>
      <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-busy={docs.loading}>
        {docs.loading && [0, 1, 2].map((i) => <DoctorCardSkeleton key={i} />)}
        {docs.data?.doctors.map((d, i) => <DoctorCard key={d.id} doctor={d} index={i} browse />)}
      </div>
      {docs.data?.doctors.length === 0 && <EmptyState title="No doctors found" icon="🔎">Try a different name or department.</EmptyState>}
    </div>
  )
}
