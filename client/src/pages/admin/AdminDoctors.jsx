import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Avatar, Button, EmptyState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea, useLoad } from '../../components/ui.jsx'
import { rupees } from '../../lib/format.js'

const BLANK = { name: '', email: '', departmentId: '', qualification: '', experienceYears: 0, fee: 0, languages: '', photoUrl: '', about: '' }

export default function AdminDoctors() {
  const docs = useLoad(() => api('/admin/doctors'))
  const deps = useLoad(() => api('/admin/departments'))
  const [form, setForm] = useState(null) // { id?, ...fields }
  const [confirm, setConfirm] = useState(null) // doctor to deactivate
  const [result, setResult] = useState(null) // invite outcome shown to the admin
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function act(fn) {
    setError('')
    try { await fn(); docs.reload() } catch (e) { setError(e.message) }
  }

  return (
    <div>
      <PageHeader title="Doctors" subtitle="Create profiles, edit details and switch doctors on or off." actions={<Button onClick={() => setForm({ ...BLANK, departmentId: deps.data?.departments.find((d) => d.active)?.id ?? '' })}>Add doctor</Button>} />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {notice && <Alert tone="success" className="mb-4">{notice}</Alert>}
      {result && <InviteResult result={result} onClose={() => setResult(null)} />}

      {docs.loading ? <Skeleton className="h-48" /> : docs.data.doctors.length === 0 ? (
        <EmptyState title="No doctors yet" icon="👩‍⚕️">Add your first doctor. They get an email with a link to set their password.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-ink-muted">
              <tr>{['Doctor', 'Department', 'Experience', 'Fee', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {docs.data.doctors.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50/70">
                  <td className="px-4 py-3"><div className="flex items-center gap-3"><Avatar name={d.name} photoUrl={d.photoUrl} size={40} /><div><p className="font-medium">{d.name}</p><p className="text-xs text-ink-muted">{d.email}</p></div></div></td>
                  <td className="px-4 py-3">{d.department}</td>
                  <td className="px-4 py-3">{d.experienceYears} yrs</td>
                  <td className="px-4 py-3">{rupees(d.fee)}</td>
                  <td className="px-4 py-3">
                    {d.active ? <span className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-semibold text-brand-900">Active</span> : <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold">Inactive</span>}
                    {d.active && !d.hasPassword && <span className="ml-2 text-xs text-amber-800">password not set yet</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => setForm({ ...d, languages: d.languages.join(', ') })}>Edit</Button>
                    {d.active && !d.hasPassword && (
                      <Button variant="ghost" size="sm" onClick={() => act(async () => { setResult(await api(`/admin/doctors/${d.id}/invite`, { method: 'POST' })) })}>New link</Button>
                    )}
                    {d.active ? (
                      <Button variant="ghost" size="sm" className="!text-red-700" onClick={() => setConfirm(d)}>Deactivate</Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => act(() => api(`/admin/doctors/${d.id}/activate`, { method: 'POST' }))}>Activate</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <DoctorForm
          initial={form}
          departments={deps.data?.departments.filter((d) => d.active || d.id === form.departmentId) || []}
          onClose={() => setForm(null)}
          onSaved={(res) => { setForm(null); docs.reload(); if (res?.setPasswordLink !== undefined) setResult(res) }}
        />
      )}
      {confirm && (
        <Modal title={`Deactivate ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="text-ink-soft">They will be signed out and hidden from booking. Their upcoming pending and confirmed appointments move to <strong>needs rebooking</strong> so patients can pick a new slot.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>Keep active</Button>
            <Button variant="danger" onClick={() => act(async () => { const r = await api(`/admin/doctors/${confirm.id}/deactivate`, { method: 'POST' }); setNotice(`${confirm.name} deactivated. ${r.movedToRebooking} appointment(s) moved to needs rebooking.`); setConfirm(null) })}>Deactivate</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function InviteResult({ result, onClose }) {
  const [copied, setCopied] = useState(false)
  return (
    <Alert tone={result.setPasswordLink ? 'warn' : 'success'} className="mb-4">
      {result.setPasswordLink ? (
        <>
          <p className="font-semibold">The email could not be sent{result.emailStatus === 'skipped' ? ' (email is not set up yet)' : ''}. Copy this link and send it to the doctor yourself. It works once, for 48 hours.</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={result.setPasswordLink} aria-label="Set password link" className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs" onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(result.setPasswordLink); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </>
      ) : <p>A "set your password" email has been sent to the doctor. The link works once, for 48 hours.</p>}
      <button onClick={onClose} className="mt-2 text-xs font-semibold underline">Dismiss</button>
    </Alert>
  )
}

function DoctorForm({ initial, departments, onClose, onSaved }) {
  const [f, setF] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const editing = !!initial.id

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const body = { name: f.name, email: f.email, departmentId: Number(f.departmentId), qualification: f.qualification, experienceYears: Number(f.experienceYears), fee: Number(f.fee), languages: f.languages, photoUrl: f.photoUrl, about: f.about }
    try { onSaved(await api(editing ? `/admin/doctors/${initial.id}` : '/admin/doctors', { method: editing ? 'PATCH' : 'POST', body })) } catch (err) { setError(err.message); setBusy(false) }
  }
  return (
    <Modal title={editing ? 'Edit doctor' : 'Add doctor'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Full name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} placeholder="Dr. Anita Rao" />}</Field>
          <Field label="Email" hint={editing ? undefined : 'The set-password link is sent here'}>{(id) => <Input id={id} type="email" required value={f.email} onChange={set('email')} />}</Field>
          <Field label="Department">{(id) => (
            <Select id={id} required value={f.departmentId} onChange={set('departmentId')}>
              <option value="" disabled>Choose…</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Qualification">{(id) => <Input id={id} value={f.qualification} onChange={set('qualification')} placeholder="MBBS, MD" />}</Field>
          <Field label="Experience (years)">{(id) => <Input id={id} type="number" min="0" max="70" value={f.experienceYears} onChange={set('experienceYears')} />}</Field>
          <Field label="Consultation fee (₹)">{(id) => <Input id={id} type="number" min="0" value={f.fee} onChange={set('fee')} />}</Field>
          <Field label="Languages" hint="Separate with commas">{(id) => <Input id={id} value={f.languages} onChange={set('languages')} placeholder="English, Hindi" />}</Field>
          <Field label="Photo URL" hint="Optional. A link starting with https://">{(id) => <Input id={id} type="url" value={f.photoUrl} onChange={set('photoUrl')} />}</Field>
        </div>
        <Field label="About" hint="One or two sentences patients will see">{(id) => <Textarea id={id} maxLength={600} value={f.about} onChange={set('about')} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>{editing ? 'Save changes' : 'Create doctor'}</Button>
        </div>
      </form>
    </Modal>
  )
}
