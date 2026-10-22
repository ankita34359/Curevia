import request from 'supertest'
import { loadConfig } from '../server/config.js'
import { openDb } from '../server/db/index.js'
import { createApp } from '../server/app.js'
import { createMailer } from '../server/services/mailer.js'
import { ensureAdmin } from '../server/services/bootstrap.js'

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
  const ctx = { config, db, mailer, emails, ...overrides.ctx }
  const app = createApp(ctx)
  return { app, db, config, emails, mailer, ctx }
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
