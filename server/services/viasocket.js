import { ViaSocket } from 'viasocket-apps'
import { NotConfigured } from './deliveries.js'

// A viaSocket run answers HTTP 200 even when a step inside it failed, so the reply body has to be read.
// Returns a short reason when the reply says something went wrong, otherwise null. Never includes request data.
export function replyProblem(body) {
  if (body === null || body === undefined || body === '') return null
  if (typeof body === 'string') return /^\s*(error|failed)\b/i.test(body) ? `Reply: ${body.slice(0, 120)}` : null
  if (typeof body !== 'object') return null
  const msg = (o) => String(o?.message || o?.error?.message || (typeof o?.error === 'string' ? o.error : '') || 'step failed').slice(0, 160)
  const bad = (o) => {
    if (!o || typeof o !== 'object') return false
    if (o.success === false || o.ok === false) return true
    if (typeof o.status === 'number' && o.status >= 400) return true
    if (typeof o.status === 'string' && /^(error|failed|failure)$/i.test(o.status)) return true
    if ('error' in o && o.error !== null && o.error !== false && o.error !== undefined) return true // a failed step becomes { error: ... }
    return false
  }
  if (bad(body)) return msg(body)
  if (bad(body.data)) return msg(body.data)
  // Several step results at once, e.g. { step1: {...}, step2: { error: ... } }
  for (const v of Object.values(body)) if (v && typeof v === 'object' && !Array.isArray(v) && bad(v)) return msg(v)
  return null
}

const FLOW_URL = /^https:\/\/flow\.sokt\.io\/func\/[A-Za-z0-9_-]+$/
export const isFlowUrl = (u) => typeof u === 'string' && FLOW_URL.test(u)

// Every call to viaSocket (flow runs, the AI, listing flows) is cut off after a limit, so one slow call cannot hold up the tick.
export const FLOW_TIMEOUT_MS = 20000
export const AI_TIMEOUT_MS = 30000

// Rejects with `message` if `promise` has not settled in `ms`. (The SDK calls take no abort signal, so the late answer is simply ignored.)
export function withTimeout(promise, ms, message) {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

export function createViaSocketService({ config, client = null, fetchImpl = globalThis.fetch, timeoutMs = FLOW_TIMEOUT_MS, aiTimeoutMs = AI_TIMEOUT_MS }) {
  const v = config.viasocket
  const missing = [['VIASOCKET_ORG_ID', v.orgId], ['VIASOCKET_PROJECT_ID', v.projectId], ['VIASOCKET_EMBED_SECRET', v.embedSecret]].filter(([, val]) => !val).map(([k]) => k)
  const configured = missing.length === 0
  let real = client
  const api = () => {
    if (!configured) throw new NotConfigured(`viaSocket is not set up: missing ${missing.join(', ')}`)
    return (real ||= new ViaSocket({ orgId: v.orgId, projectId: v.projectId, secret: v.embedSecret }))
  }
  return {
    configured,
    missing,
    uniqueId: v.uniqueId,
    orgId: v.orgId,
    projectId: v.projectId,
    // The embed token for the admin's browser (HS256 JWT: org_id, project_id, unique_identifier).
    embedToken: () => api().tokenFor(v.uniqueId),
    // The flows the admin built in the prebuilt UI: [{ id, title, status, webhook, ... }]
    listFlows: () => withTimeout(Promise.resolve().then(() => api().user(v.uniqueId).listFlows()), timeoutMs, 'viaSocket did not answer in time'),
    // viaSocket's AI API, server side only. Returns the parsed JSON answer (responseType json_schema).
    async ai(request) {
      const out = await withTimeout(Promise.resolve().then(() => api().user(v.uniqueId).ai.send(request)), aiTimeoutMs, 'The AI did not answer in time')
      if (out?.finishReason === 'truncated') throw new Error('The AI answer was cut off')
      return out?.content
    },
    // Runs a flow. Throws unless the run really worked: HTTP error, or an error inside the reply body.
    async postToFlow(url, payload) {
      if (!isFlowUrl(url)) throw new Error('Stored flow address is not a viaSocket flow URL')
      let res
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        throw new Error(e?.name === 'TimeoutError' ? 'viaSocket did not answer in time' : `Could not reach viaSocket (${e?.code || e?.name || 'network error'})`)
      }
      const text = await res.text()
      let body = text
      try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
      if (!res.ok) {
        const e = new Error(`viaSocket answered ${res.status}${typeof body === 'object' && body?.message ? `: ${String(body.message).slice(0, 120)}` : ''}`)
        e.status = res.status
        e.paused = /paused/i.test(text)
        throw e
      }
      const problem = replyProblem(body)
      if (problem) throw new Error(`viaSocket reported an error: ${problem}`)
      return body
    }
  }
}
