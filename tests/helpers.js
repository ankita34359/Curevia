import request from 'supertest'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../server/config.js'
import { openDb } from '../server/db/index.js'
import { createApp } from '../server/app.js'
import { createMailer } from '../server/services/mailer.js'
import { ensureAdmin } from '../server/services/bootstrap.js'

const bcryptSync = (pw) => bcrypt.hashSync(pw, 4)
export const ADMIN = { email: 'admin@test.local', password: 'admin-pass-123' }

// Captures emails instead of sending them (stands in for the viaSocket email_sender slot).
export function fakeEmailTransport() {
  const sent = []
  return {
    sent,
    failNext: false,
    async sendEmail(msg) {
      if (this.failNext) { this.failNext = false; throw new Error('boom') }
      sent.push(msg)
    }
  }
}

export async function makeApp(overrides = {}) {
  const config = {
    ...loadConfig({
      SESSION_SECRET: 'test-session-secret-123456',
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      APP_URL: 'http://localhost:3000',
      BCRYPT_COST: '4'
    }),
    ...overrides.config
  }
  const db = openDb(':memory:')
  await ensureAdmin(db, config)
  const emails = fakeEmailTransport()
  const mailer = createMailer({ db, transport: overrides.noEmail ? null : emails })
  // Tests move time with clock.now = new Date(...)
  const clock = { now: overrides.now || new Date('2026-10-22T04:00:00.000Z') }
  const ctx = { config, db, mailer, emails, clock: () => clock.now, ...overrides.ctx }
  const app = createApp(ctx)
  return { app, db, config, emails, mailer, ctx, clock, notifier: app.locals.ctx.notifier }
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
