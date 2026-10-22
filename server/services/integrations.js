import { NotConfigured } from './deliveries.js'
import { SLOTS, SLOT_NAMES } from '../integrations/slots.js'
import { isFlowUrl } from './viasocket.js'
import { HttpError } from '../lib/http.js'

const FLOW_ID = /^[A-Za-z0-9_-]{4,80}$/

// Keeps what the admin built in the prebuilt UI, one flow per slot, and sends data through those flows.
export function createIntegrations({ db, viasocket, clock = () => new Date() }) {
  const get = (slot) => db.prepare('SELECT * FROM integrations WHERE slot = ?').get(slot)
  const save = (slot, f) => {
    const cur = get(slot)
    const t = clock().toISOString()
    if (!cur) db.prepare('INSERT INTO integrations (slot, flow_id, status, webhook_url, flow_title, updated_at) VALUES (?,?,?,?,?,?)').run(slot, f.flow_id ?? null, f.status ?? 'none', f.webhook_url ?? null, f.flow_title ?? null, t)
    else db.prepare('UPDATE integrations SET flow_id = ?, status = ?, webhook_url = ?, flow_title = ?, updated_at = ? WHERE slot = ?').run(
      'flow_id' in f ? f.flow_id : cur.flow_id, f.status ?? cur.status, 'webhook_url' in f ? f.webhook_url : cur.webhook_url, 'flow_title' in f ? f.flow_title : cur.flow_title, t, slot)
  }

  function assertSlot(slot) {
    if (!SLOT_NAMES.includes(slot)) throw new HttpError(404, 'Unknown integration slot')
  }

  // Called with what the browser's embed reported. The browser only names the flow; the address and status
  // are read back from viaSocket itself, never taken from the browser.
  async function recordEvent(slot, { flowId, action }) {
    assertSlot(slot)
    if (!FLOW_ID.test(String(flowId || ''))) throw new HttpError(400, 'Missing flow id')
    const other = db.prepare('SELECT slot FROM integrations WHERE flow_id = ? AND slot != ?').get(flowId, slot)
    if (other) throw new HttpError(409, `That flow is already used for ${other.slot}`)
    if (action === 'initiated') {
      const cur = get(slot)
      if (!cur?.flow_id || cur.status === 'deleted' || cur.status === 'none') save(slot, { flow_id: flowId, status: 'drafted', webhook_url: null })
      return state(slot)
    }
    if (action === 'deleted') { save(slot, { flow_id: null, status: 'none', webhook_url: null, flow_title: null }); return state(slot) }
    if (!['published', 'updated', 'paused'].includes(action)) throw new HttpError(400, 'Unknown flow event')
    const flows = await viasocket.listFlows()
    const flow = flows.find((f) => f.id === flowId)
    if (!flow) throw new HttpError(409, 'viaSocket does not list that flow yet. Wait a moment and press "Check again".')
    applyFlow(slot, flow)
    return state(slot)
  }

  function applyFlow(slot, flow) {
    const status = flow.status === 'active' ? 'active' : flow.status === 'paused' ? 'paused' : flow.status === 'deleted' ? 'deleted' : 'drafted'
    const url = isFlowUrl(flow.webhook) ? flow.webhook : null
    if (status === 'active' && !url) throw new HttpError(502, 'viaSocket returned an unexpected flow address')
    save(slot, { flow_id: flow.id, status: status === 'deleted' ? 'none' : status, webhook_url: status === 'active' || status === 'paused' ? url : null, flow_title: String(flow.title || '').slice(0, 120) })
  }

  // Re-reads each slot's flow from viaSocket (catches pausing/deleting done inside the embed or on viaSocket).
  async function sync() {
    if (!viasocket.configured) return
    const flows = await viasocket.listFlows()
    for (const slot of SLOT_NAMES) {
      const cur = get(slot)
      if (!cur?.flow_id) continue
      const flow = flows.find((f) => f.id === cur.flow_id)
      if (flow) applyFlow(slot, flow)
      else if (cur.status === 'active' || cur.status === 'paused') save(slot, { flow_id: null, status: 'none', webhook_url: null, flow_title: null })
    }
  }

  function disconnect(slot) {
    assertSlot(slot)
    save(slot, { flow_id: null, status: 'none', webhook_url: null, flow_title: null })
  }

  // Sends one payload through the slot's flow. NotConfigured when the slot has no active flow.
  async function send(slot, payload) {
    assertSlot(slot)
    const row = get(slot)
    if (!viasocket.configured) throw new NotConfigured(`viaSocket is not set up: missing ${viasocket.missing.join(', ')}`)
    if (!row || row.status !== 'active' || !row.webhook_url) throw new NotConfigured(`${SLOTS[slot].label} is not set up yet`)
    try {
      return await viasocket.postToFlow(row.webhook_url, payload)
    } catch (e) {
      if (e.paused) save(slot, { status: 'paused' })
      throw e
    }
  }

  function state(slot) {
    const row = get(slot)
    const def = SLOTS[slot]
    const stats = db.prepare("SELECT status, COUNT(*) n, MAX(updated_at) last FROM deliveries WHERE channel = ? AND created_at >= ? GROUP BY status").all(def.channel, new Date(clock().getTime() - 7 * 86400000).toISOString())
    const lastFailure = db.prepare("SELECT error, updated_at FROM deliveries WHERE channel = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1").get(def.channel)
    return {
      slot,
      label: def.label,
      appName: def.appName,
      actionName: def.actionName,
      actionId: def.actionId,
      description: def.description,
      steps: def.steps,
      sample: def.sample,
      status: row?.status || 'none',
      flowId: row?.flow_id || null, // safe to give the browser: it only reopens the flow. The run URL never leaves the server.
      flowTitle: row?.flow_title || null,
      last7Days: Object.fromEntries(['sent', 'failed', 'skipped'].map((s) => [s, stats.find((x) => x.status === s)?.n || 0])),
      lastFailure: lastFailure ? { error: lastFailure.error, at: lastFailure.updated_at } : null
    }
  }

  return { SLOT_NAMES, recordEvent, sync, disconnect, send, state, states: () => SLOT_NAMES.map(state), get }
}
