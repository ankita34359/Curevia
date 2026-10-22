import { useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Button, Field, Input, Modal, PageHeader, Select, Skeleton, useLoad } from '../../components/ui.jsx'
import { DEPARTMENT_ICONS, iconFor } from '../../lib/format.js'

export default function AdminDepartments() {
  const deps = useLoad(() => api('/admin/departments'))
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')

  async function toggle(d) {
    setError('')
    try { await api(`/admin/departments/${d.id}`, { method: 'PATCH', body: { active: !d.active } }); deps.reload() } catch (e) { setError(e.message) }
  }
  return (
    <div>
      <PageHeader title="Departments" subtitle="Patients browse doctors by department." actions={<Button onClick={() => setForm({ name: '', description: '', icon: 'stethoscope' })}>Add department</Button>} />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {deps.loading ? <Skeleton className="h-40" /> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {deps.data.departments.map((d, i) => (
            <div key={d.id} className={`card animate-fade-up p-5 ${d.active ? '' : 'opacity-60'}`} style={{ animationDelay: `${i * 50}ms` }}>
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-2xl" aria-hidden="true">{iconFor(d.icon)}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold">{d.name}</h3>
                  <p className="text-xs text-ink-muted">{d.doctorCount} active doctor{d.doctorCount === 1 ? '' : 's'}{d.active ? '' : ' · hidden from patients'}</p>
                </div>
              </div>
              {d.description && <p className="mt-3 text-sm text-ink-soft">{d.description}</p>}
              <div className="mt-4 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setForm(d)}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => toggle(d)}>{d.active ? 'Hide' : 'Show'}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {form && <DepartmentForm initial={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); deps.reload() }} />}
    </div>
  )
}

function DepartmentForm({ initial, onClose, onSaved }) {
  const [f, setF] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const body = { name: f.name, description: f.description, icon: f.icon }
      await api(initial.id ? `/admin/departments/${initial.id}` : '/admin/departments', { method: initial.id ? 'PATCH' : 'POST', body })
      onSaved()
    } catch (err) { setError(err.message); setBusy(false) }
  }
  return (
    <Modal title={initial.id ? 'Edit department' : 'Add department'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Short description">{(id) => <Input id={id} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Icon">{(id) => (
          <Select id={id} value={f.icon} onChange={(e) => setF({ ...f, icon: e.target.value })}>
            {Object.entries(DEPARTMENT_ICONS).map(([k, v]) => <option key={k} value={k}>{v} {k}</option>)}
          </Select>
        )}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  )
}
