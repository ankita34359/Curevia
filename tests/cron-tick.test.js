import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeApp, addDoctor, addPatient, addAppointment } from './helpers.js'
import { createTick } from '../server/services/tick.js'
import { createViaSocketService, withTimeout } from '../server/services/viasocket.js'
import { createHoldingApp } from '../server/holding.js'

const SECRET = 'cron-secret-for-tests'
const AUTH = ['Authorization', `Bearer ${SECRET}`]
const MIN = 60000
const never = () => new Promise(() => {})
const gate = () => { let open; const p = new Promise((r) => { open = r }); return { p, open } }
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)) } }

// A tick with a fake agent that waits on a gate, to stand in for slow work.
function slowTick(extra = {}) {
  const g = gate()
  const seen = { agentRuns: 0, timeUp: null }
  const agent = { run: async ({ timeUp } = {}) => { seen.agentRuns++; seen.timeUp = timeUp; await g.p; return { decisions: 0 } } }
  const db = { prepare: () => ({ run: () => ({}), all: () => [], get: () => undefined }) }
  const notifications = { retryFailed: async () => 0 }
  const tick = createTick({ db, config: {}, mailer: {}, notifications, agent, ...extra })
  return { tick, g, seen }
}

describe('cron route answers at once and works in the background', () => {
  it('replies 202 while the work is still running; a second call just replies and skips; a later call runs again', async () => {
    const { tick, g, seen } = slowTick()
    const w = await makeApp({ config: { cronSecret: SECRET }, ctx: { tick } })

    const t0 = Date.now()
    const first = await request(w.app).get('/api/cron/tick').set(...AUTH)
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ accepted: true, started: true })
    expect(Date.now() - t0).toBeLessThan(1000) // the agent is still blocked on the gate

    await until(() => seen.agentRuns === 1)
    const second = await request(w.app).post('/api/cron/tick').set(...AUTH)
    expect(second.status).toBe(202)
    expect(second.body).toMatchObject({ accepted: true, started: false, skipped: 'already running' })
    expect(seen.agentRuns).toBe(1) // the second call did not start a second run

    g.open()
    await until(() => !tick.isRunning())
    const third = await request(w.app).get('/api/cron/tick').set(...AUTH)
    expect(third.body).toMatchObject({ started: true })
    await until(() => seen.agentRuns === 2)
  })

  it('still checks the secret before anything starts (401, nothing runs)', async () => {
    const { tick, g, seen } = slowTick()
    const w = await makeApp({ config: { cronSecret: SECRET }, ctx: { tick } })
    await request(w.app).get('/api/cron/tick').expect(401)
    await request(w.app).get('/api/cron/tick').set('Authorization', 'Bearer nope').expect(401)
    expect(seen.agentRuns).toBe(0)
    expect(tick.isRunning()).toBe(false)
    g.open()
  })

  it('a failure in the background work is logged, does not crash, and frees the lock', async () => {
    const boom = createTick({ db: (await makeApp()).db, config: {}, mailer: {}, notifications: { retryFailed: async () => 0 }, agent: { run: async () => { throw new Error('agent exploded') } } })
    const w = await makeApp({ config: { cronSecret: SECRET }, ctx: { tick: boom } })
    const res = await request(w.app).get('/api/cron/tick').set(...AUTH)
    expect(res.status).toBe(202)
    await until(() => !boom.isRunning())
    expect(boom.start()).toMatchObject({ started: true })
  })
})

describe('tick lock', () => {
  it('start() while run() is going skips, and run() while start() is going skips', async () => {
    const { tick, g } = slowTick()
    const running = tick.run()
    await until(() => tick.isRunning())
    expect(tick.start()).toEqual({ started: false, skipped: 'already running' })
    expect(await tick.run()).toEqual({ skipped: 'already running' })
    g.open()
    await running
    expect(tick.isRunning()).toBe(false)

    const s = slowTick()
    expect(s.tick.start()).toEqual({ started: true })
    expect(await s.tick.run()).toEqual({ skipped: 'already running' })
    s.g.open()
    await until(() => !s.tick.isRunning())
  })

  it('a run that has hung for longer than the lock time no longer blocks the next tick', async () => {
    let t = 0
    const { tick, g } = slowTick({ nowMs: () => t, lockTtlMs: 10 * MIN })
    const hung = tick.run()
    await until(() => tick.isRunning())
    t += 9 * MIN
    expect(await tick.run()).toEqual({ skipped: 'already running' })
    t += 2 * MIN // 11 minutes: the old lock is dead
    const fresh = tick.start()
    expect(fresh).toEqual({ started: true })
    g.open() // the old run finishes now; it must not release the newer run's lock
    await hung
    await until(() => !tick.isRunning())
  })

  it('stops starting new work once the time budget is used up', async () => {
    let t = 0
    const { tick, g, seen } = slowTick({ nowMs: () => t, budgetMs: 100 })
    const done = tick.run()
    await until(() => seen.agentRuns === 1)
    expect(seen.timeUp()).toBe(false)
    t += 101
    expect(seen.timeUp()).toBe(true)
    g.open()
    expect((await done).cutShort).toBe(true)
  })

  it('skips the retries and the agent when the budget is already gone before they start', async () => {
    let t = 0
    const calls = []
    const agent = { run: async () => { calls.push('agent'); return {} } }
    const notifications = { retryFailed: async () => { calls.push('retry'); return 0 } }
    const mailer = { send: async () => { calls.push('mail'); t += 1000; return { status: 'sent' } } }
    const w = await makeApp()
    const { doctorId } = addDoctor(w.db)
    const p = addPatient(w.db)
    const soon = new Date(w.clock.now.getTime() + 23 * 60 * MIN).toISOString()
    for (let i = 0; i < 3; i++) {
      const id = addAppointment(w.db, { doctorId, patientId: p, startUtc: new Date(Date.parse(soon) + i * 20 * MIN).toISOString(), status: 'confirmed' })
      w.db.prepare('UPDATE appointments SET confirmed_at = ? WHERE id = ?').run(new Date(w.clock.now.getTime() - 3000 * MIN).toISOString(), id)
    }
    const tick = createTick({ db: w.db, config: { appUrl: 'http://x' }, mailer, notifications, agent, clock: () => w.clock.now, nowMs: () => t, budgetMs: 1500 })
    const out = await tick.run()
    expect(calls.filter((c) => c === 'mail')).toHaveLength(2) // the budget ran out after two reminders
    expect(calls).not.toContain('retry')
    expect(calls).not.toContain('agent')
    expect(out.cutShort).toBe(true)
  })
})

describe('viaSocket calls have a time limit', () => {
  const config = { viasocket: { orgId: '1', projectId: 'p', embedSecret: 's', uniqueId: 'u' } }
  const hanging = { tokenFor: async () => 't', user: () => ({ listFlows: never, ai: { send: never } }) }

  it('withTimeout rejects with the message when the promise never settles, and passes real results through', async () => {
    await expect(withTimeout(never(), 20, 'too slow')).rejects.toThrow('too slow')
    await expect(withTimeout(Promise.resolve(5), 20, 'too slow')).resolves.toBe(5)
  })
  it('the AI call gives up', async () => {
    const vs = createViaSocketService({ config, client: hanging, aiTimeoutMs: 30 })
    await expect(vs.ai({})).rejects.toThrow('The AI did not answer in time')
  })
  it('listing flows gives up', async () => {
    const vs = createViaSocketService({ config, client: hanging, timeoutMs: 30 })
    await expect(vs.listFlows()).rejects.toThrow('viaSocket did not answer in time')
  })
  it('a flow run that never answers is cut off, even though HTTP never replied', async () => {
    const fetchImpl = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
    const vs = createViaSocketService({ config, client: hanging, fetchImpl, timeoutMs: 30 })
    await expect(vs.postToFlow('https://flow.sokt.io/func/abc', { a: 1 })).rejects.toThrow('viaSocket did not answer in time')
  })
  it('the real limits are short enough that one call cannot eat a whole tick', async () => {
    const { FLOW_TIMEOUT_MS, AI_TIMEOUT_MS } = await import('../server/services/viasocket.js')
    expect(FLOW_TIMEOUT_MS).toBeLessThanOrEqual(30000)
    expect(AI_TIMEOUT_MS).toBeLessThanOrEqual(30000)
  })

  it('a tick with an AI that never answers still finishes quickly: the agent falls back to fixed rules', async () => {
    const w = await makeApp({ config: { cronSecret: SECRET }, timeouts: { aiTimeoutMs: 30, timeoutMs: 30 } })
    w.fake.ai = never
    const { doctorId } = addDoctor(w.db)
    const p = addPatient(w.db)
    const id = addAppointment(w.db, { doctorId, patientId: p, startUtc: new Date(w.clock.now.getTime() + 30 * 60 * MIN).toISOString(), status: 'pending' })
    w.db.prepare('UPDATE appointments SET created_at = ? WHERE id = ?').run(new Date(w.clock.now.getTime() - 180 * MIN).toISOString(), id)
    const t0 = Date.now()
    const res = await request(w.app).get('/api/cron/tick').set(...AUTH)
    expect(res.status).toBe(202)
    await until(() => !w.tick.isRunning())
    expect(Date.now() - t0).toBeLessThan(3000)
    const row = w.db.prepare('SELECT source, ai_error FROM agent_log WHERE appointment_id = ?').get(id)
    expect(row.source).toBe('fallback')
    expect(row.ai_error).toMatch(/did not answer in time/)
  })
})

describe('holding mode (missing settings)', () => {
  const holding = (cronSecret) => createHoldingApp('Server is missing settings. Missing required environment variables: SESSION_SECRET', { cronSecret })

  it('the tick answers quickly: 401 without the bearer token, 503 (and nothing run) with it, for GET and POST', async () => {
    const app = holding(SECRET)
    for (const m of ['get', 'post']) {
      const t0 = Date.now()
      await request(app)[m]('/api/cron/tick').expect(401)
      await request(app)[m]('/api/cron/tick').set('Authorization', 'Bearer wrong').expect(401)
      const ok = await request(app)[m]('/api/cron/tick').set(...AUTH)
      expect(ok.status).toBe(503)
      expect(ok.body).toMatchObject({ ran: false })
      expect(ok.body.error).toMatch(/SESSION_SECRET/)
      expect(Date.now() - t0).toBeLessThan(1000)
    }
  })
  it('is always 401 when no CRON_SECRET is known', async () => {
    await request(holding('')).get('/api/cron/tick').set('Authorization', 'Bearer ').expect(401)
    await request(holding(undefined)).get('/api/cron/tick').set('Authorization', 'Bearer undefined').expect(401)
  })
  it('the page and other API paths still answer 503, and /healthz says not ready', async () => {
    const app = holding(SECRET)
    expect((await request(app).get('/')).status).toBe(503)
    expect((await request(app).get('/api/public/doctors')).status).toBe(503)
    expect((await request(app).get('/healthz')).body).toEqual({ ok: true, ready: false })
  })
})
