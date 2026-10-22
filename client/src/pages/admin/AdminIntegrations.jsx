import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { Alert, Button, Modal, PageHeader, Skeleton, useLoad } from '../../components/ui.jsx'

const EMBED_SCRIPT = 'https://embed.viasocket.com/prod-embedcomponent.js'
const STATUS = {
  none: ['Not set up', 'bg-slate-200 text-slate-700'],
  drafted: ['Draft: finish and publish it', 'bg-accent-100 text-amber-900'],
  active: ['Active', 'bg-brand-100 text-brand-900'],
  paused: ['Paused', 'bg-orange-100 text-orange-900']
}

function loadEmbedScript() {
  if (window.viaSocket) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = EMBED_SCRIPT
    s.onload = resolve
    s.onerror = () => reject(new Error('Could not load the viaSocket embed script. Check your internet connection.'))
    document.head.appendChild(s)
  })
}

export default function AdminIntegrations() {
  const state = useLoad(() => api('/admin/integrations?sync=1'))
  const [active, setActive] = useState(null) // slot being edited in the embed
  const [embedError, setEmbedError] = useState('')
  const [testing, setTesting] = useState('')
  const [testResult, setTestResult] = useState({})
  const [confirm, setConfirm] = useState(null)
  const embedRef = useRef(null)
  const activeRef = useRef(null)
  const slotsRef = useRef([])
  slotsRef.current = state.data?.slots || []
  activeRef.current = active
  const onFlowRef = useRef(() => {})

  // Flow events from the embed. Only the flow id and what happened go to our server; the server reads the rest from viaSocket.
  const report = useCallback(async (slot, flowId, action, attempt = 0) => {
    try {
      await api(`/admin/integrations/${slot}/event`, { method: 'POST', body: { flowId, action } })
      state.reload()
    } catch (e) {
      if (e.status === 409 && attempt < 3) return setTimeout(() => report(slot, flowId, action, attempt + 1), 2500)
      setEmbedError(e.message)
    }
  }, [state.reload]) // eslint-disable-line react-hooks/exhaustive-deps

  // The listener is registered on the embed object right after it is mounted (before any flow is opened).
  const onFlow = useCallback((flow) => {
    if (!flow?.id || !flow.action) return
    const slot = slotsRef.current.some((s) => s.slot === flow.metadata) ? flow.metadata : activeRef.current
    if (slot) report(slot, flow.id, flow.action)
  }, [report])
  onFlowRef.current = onFlow
  useEffect(() => () => { embedRef.current?.destroy?.(); embedRef.current = null }, [])

  async function openSlot(slot) {
    setEmbedError('')
    setActive(slot.slot)
    try {
      if (!embedRef.current) {
        const [{ token }] = await Promise.all([api('/admin/integrations/embed'), loadEmbedScript()])
        embedRef.current = window.viaSocket.mount({
          embedToken: token,
          parent: '#integrations-embed',
          // Form only: no catalog, no back button, no multi-step editor.
          config: { showEnabled: false, hideadvancedflowbutton: true, pageheading: 'Connection' }
        })
        embedRef.current.on('flow', (flow) => onFlowRef.current(flow))
      }
      // Reopen this slot's existing flow if it has one, instead of creating another draft.
      if (slot.flowId) embedRef.current.open(slot.flowId, { dummy_payload: slot.sample, meta: slot.slot })
      else embedRef.current.open(undefined, { actionId: slot.actionId, dummy_payload: slot.sample, meta: slot.slot })
      document.getElementById('integrations-embed')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch (e) {
      setEmbedError(e.message)
    }
  }

  async function test(slot) {
    setTesting(slot)
    try {
      const res = await api(`/admin/integrations/${slot}/test`, { method: 'POST' })
      setTestResult((r) => ({ ...r, [slot]: { ok: true, ...res } }))
      state.reload()
    } catch (e) { setTestResult((r) => ({ ...r, [slot]: { ok: false, error: e.message } })) } finally { setTesting('') }
  }

  const slots = state.data?.slots || []
  const current = slots.find((s) => s.slot === active)
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Connect Google Sheets, Gmail and Slack through viaSocket. Set each one up once." actions={<Button variant="secondary" onClick={state.reload}>Check again</Button>} />
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {state.data && !state.data.configured && (
        <Alert tone="warn" className="mb-6">
          <p className="font-semibold">viaSocket is not connected yet.</p>
          <p className="mt-1">Add {state.data.missing.map((m) => <code key={m} className="mx-0.5 rounded bg-white px-1.5 py-0.5 text-xs">{m}</code>)} on the hosting secrets page and restart the app. Until then the booking app works, but no emails, sheet rows or Slack alerts are sent.</p>
        </Alert>
      )}
      {embedError && <Alert tone="error" className="mb-4">{embedError}</Alert>}

      <div className="grid gap-5 lg:grid-cols-3">
        {state.loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}
        {slots.map((s, i) => {
          const [label, tone] = STATUS[s.status]
          const t = testResult[s.slot]
          return (
            <section key={s.slot} className="card flex animate-fade-up flex-col p-5" style={{ animationDelay: `${i * 70}ms` }} aria-labelledby={`h-${s.slot}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 id={`h-${s.slot}`} className="font-semibold">{s.label}</h2>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{s.description}</p>
              <p className="mt-3 text-xs text-ink-muted">Uses <strong>{s.appName}</strong> → <strong>{s.actionName}</strong></p>
              <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-center text-xs">
                {['sent', 'failed', 'skipped'].map((k) => <div key={k}><dt className="text-ink-muted">{k}</dt><dd className={`text-lg font-bold tabular-nums ${k === 'failed' && s.last7Days.failed ? 'text-red-700' : ''}`}>{s.last7Days[k]}</dd></div>)}
              </dl>
              <p className="mt-1 text-center text-[11px] text-ink-muted">last 7 days</p>
              {s.lastFailure && <p className="mt-2 text-xs text-red-700">Last failure: {s.lastFailure.error}</p>}
              {t && <p className={`mt-2 text-xs ${t.ok && t.result === 'sent' ? 'text-brand-800' : 'text-red-700'}`} role="status">{t.ok ? (t.result === 'sent' ? 'Test sent. Check the destination.' : `Test ${t.result}: ${t.error || ''}`) : t.error}</p>}
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button size="sm" disabled={!state.data.configured} onClick={() => openSlot(s)}>{s.flowId ? 'Edit flow' : 'Set up'}</Button>
                <Button size="sm" variant="secondary" disabled={s.status !== 'active'} loading={testing === s.slot} onClick={() => test(s.slot)}>Send test</Button>
                {s.flowId && <Button size="sm" variant="ghost" className="!text-red-700" onClick={() => setConfirm(s)}>Disconnect</Button>}
              </div>
            </section>
          )
        })}
      </div>

      <section className={`mt-8 ${active ? '' : 'hidden'}`} aria-label="viaSocket setup">
        {current && (
          <div className="card mb-4 animate-fade-up p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Setting up: {current.label}</h2>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-soft">{current.steps.map((t) => <li key={t}>{t}</li>)}</ol>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setActive(null)}>Close</Button>
            </div>
            <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-brand-700">Data Curevia sends (sample)</summary>
              <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs">{JSON.stringify(current.sample, null, 2)}</pre>
            </details>
          </div>
        )}
        <div id="integrations-embed" className="overflow-hidden rounded-2xl border border-slate-200 bg-white" style={{ height: 640 }} />
      </section>

      {confirm && (
        <Modal title={`Disconnect ${confirm.label}?`} onClose={() => setConfirm(null)}>
          <p className="text-ink-soft">Curevia stops using this flow. Nothing is deleted on viaSocket. You can set it up again at any time.</p>
          <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirm(null)}>Keep it</Button><Button variant="danger" onClick={async () => { await api(`/admin/integrations/${confirm.slot}/disconnect`, { method: 'POST' }); setConfirm(null); state.reload() }}>Disconnect</Button></div>
        </Modal>
      )}
    </div>
  )
}
