import request from 'supertest'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../server/config.js'
import { openDb } from '../server/db/index.js'
import { createApp } from '../server/app.js'
import { buildServices } from '../server/services/index.js'
import { ensureAdmin } from '../server/services/bootstrap.js'

const bcryptSync = (pw) => bcrypt.hashSync(pw, 4)
export const ADMIN = { email: 'admin@test.local', password: 'admin-pass-123' }

export const FLOW_URL = (slot) => `https://flow.sokt.io/func/test-${slot}`

// A fake viaSocket: signs nothing real, lists flows, and records every POST to a flow URL.
// `reply(url, body)` can be set to change what a flow answers (e.g. HTTP 200 with an error inside).
export function fakeViaSocket() {
  const fake = {
    posts: [],
    flows: [],
    aiCalls: [],
    ai: null, // (request) => { content: {...}, finishReason } | throws
    nextReply: null, // { status, body } for the next POST only
    replyFor: null, // (url, payload) => { status, body } | undefined
    client: {
      tokenFor: async (id) => `fake-token-for-${id}`,
      user: () => ({
        listFlows: async () => fake.flows,
        ai: { send: async (req) => { fake.aiCalls.push(req); if (!fake.ai) throw new Error('AI is down'); return fake.ai(req) } }
      })
    },
    fetch: async (url, init) => {
      const payload = JSON.parse(init.body)
      const r = fake.nextReply || fake.replyFor?.(url, payload) || { status: 200, body: { ok: true } }
      fake.nextReply = null
      fake.posts.push({ url, payload, ok: r.status >= 200 && r.status < 300 })
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
    },
    postsTo: (slot) => fake.posts.filter((p) => p.ok && p.url === FLOW_URL(slot)).map((p) => p.payload)
  }
  return fake
}

export async function makeApp(overrides = {}) {
  const config = {
    ...loadConfig({
      SESSION_SECRET: 'test-session-secret-123456',
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      APP_URL: 'http://localhost:3000',
      BCRYPT_COST: '4',
      VIASOCKET_ORG_ID: '1',
      VIASOCKET_PROJECT_ID: 'projTest',
      VIASOCKET_EMBED_SECRET: 'fake-embed-secret-for-tests',
      VIASOCKET_UNIQUE_ID: 'curevia-test'
    }),
    ...overrides.config
  }
  const db = openDb(':memory:')
  await ensureAdmin(db, config)
  // Tests move time with clock.now = new Date(...)
  const clock = { now: overrides.now || new Date('2026-10-22T04:00:00.000Z') }
  const fake = fakeViaSocket()
  const services = buildServices({ config, db, clock: () => clock.now, client: fake.client, fetchImpl: fake.fetch, timeouts: overrides.timeouts })
  // Every slot is "published" unless the test says otherwise (noEmail turns the email slot off).
  const off = new Set(overrides.noEmail ? ['email_sender'] : overrides.off || [])
  for (const slot of ['appointments_sheet', 'email_sender', 'slack_alert']) {
    if (off.has(slot)) continue
    db.prepare("INSERT INTO integrations (slot, flow_id, status, webhook_url, flow_title, updated_at) VALUES (?,?, 'active', ?, ?, ?)").run(slot, `test-${slot}`, FLOW_URL(slot), slot, new Date().toISOString())
    fake.flows.push({ id: `test-${slot}`, title: slot, status: 'active', webhook: FLOW_URL(slot), description: '', authId: 'a', serviceId: 's' })
  }
  // Older tests read emails.sent / emails.failNext; they are views on the fake flow.
  const emails = {
    get sent() { return fake.postsTo('email_sender').map((p) => ({ to: p.to, subject: p.subject, body: p.body })) },
    set failNext(v) { if (v) fake.nextReply = { status: 500, body: { message: 'boom' } } }
  }
  const ctx = { config, db, clock: () => clock.now, ...services, emails, fake, ...overrides.ctx }
  const app = createApp(ctx)
  return { app, db, config, emails, fake, mailer: services.mailer, ctx, clock, notifier: services.notifier, tick: services.tick, agent: services.agent, services }
}

// A supertest agent that keeps cookies and sends the same-origin header browsers send.
export function agentFor(app) {
  const agent = request.agent(app)
  agent.set('Origin', 'http://localhost:3000')
  return agent
}

export async function login(app, email, password) {
  const agent = agentFor(app)
  const res = await agent.post('/api/auth/login').send({ email, password })
  if (res.status !== 200) throw new Error(`login failed ${res.status}`)
  return agent
}

export const linkToken = (html) => decodeURIComponent(/token=([^"&]+)/.exec(html)[1])

// Inserts a demo department + doctor with a Mon-Fri 09:00-12:00 IST, 30-minute availability.
export function addDoctor(db, { email = 'doc@test.local', name = 'Dr Test', dept = 'General', slot = 30 } = {}) {
  const t = new Date().toISOString()
  db.prepare('INSERT OR IGNORE INTO departments (name, created_at) VALUES (?, ?)').run(dept, t)
  const depId = db.prepare('SELECT id FROM departments WHERE name = ?').get(dept).id
  const u = db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('doctor', ?, ?, ?, ?, ?)").run(email, name, bcryptSync('password-123'), t, t)
  const d = db.prepare('INSERT INTO doctors (user_id, department_id, created_at) VALUES (?, ?, ?)').run(u.lastInsertRowid, depId, t)
  for (let wd = 1; wd <= 5; wd++) db.prepare('INSERT INTO availability (doctor_id, weekday, start_time, end_time, slot_minutes) VALUES (?,?,?,?,?)').run(d.lastInsertRowid, wd, '09:00', '12:00', slot)
  return { userId: Number(u.lastInsertRowid), doctorId: Number(d.lastInsertRowid), departmentId: depId }
}

export function addPatient(db, email = 'pat@test.local', name = 'Pat Test') {
  const t = new Date().toISOString()
  const u = db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('patient', ?, ?, ?, ?, ?)").run(email, name, bcryptSync('password-123'), t, t)
  return Number(u.lastInsertRowid)
}

export function addAppointment(db, { doctorId, patientId, startUtc, minutes = 30, status = 'pending', name = 'Pat Test' }) {
  const end = new Date(new Date(startUtc).getTime() + minutes * 60000).toISOString()
  const t = new Date().toISOString()
  return Number(
    db
      .prepare(
        `INSERT INTO appointments (patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(patientId, doctorId, startUtc, end, status, name, 30, 'female', '9000000000', 'pat@test.local', 'Fake reason', t, t).lastInsertRowid
  )
}
