import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeApp, agentFor, login, linkToken, ADMIN } from './helpers.js'
import { issueToken } from '../server/services/authTokens.js'
import { hashPassword } from '../server/auth/passwords.js'

async function addUser(ctx, role, email, password = 'password-123', extra = {}) {
  const hash = await hashPassword(password, 4)
  const info = ctx.db
    .prepare('INSERT INTO users (role, email, name, password_hash, email_verified_at, active, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(role, email, `Test ${role}`, hash, extra.unverified ? null : new Date().toISOString(), extra.active ?? 1, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

describe('login and roles', () => {
  it('admin can sign in; wrong password is refused with a generic message', async () => {
    const { app } = await makeApp()
    const bad = await agentFor(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'nope-nope-1' })
    expect(bad.status).toBe(401)
    expect(bad.body.error).toBe('Invalid email or password')
    const unknown = await agentFor(app).post('/api/auth/login').send({ email: 'ghost@test.local', password: 'nope-nope-1' })
    expect(unknown.body.error).toBe('Invalid email or password')
    const ok = await agentFor(app).post('/api/auth/login').send({ email: ADMIN.email.toUpperCase(), password: ADMIN.password })
    expect(ok.status).toBe(200)
    expect(ok.body.user.role).toBe('admin')
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/i)
  })

  it('session cookie is signed: a tampered cookie is treated as signed out', async () => {
    const { app } = await makeApp()
    const res = await request(app).get('/api/auth/me').set('Cookie', 'curevia_sid=s%3Aforged.value')
    expect(res.body.user).toBeNull()
  })

  it('role routers refuse other roles on the server', async () => {
    const { Router } = await import('express')
    const probe = Router().get('/ping', (_req, res) => res.json({ ok: true }))
    const { app, ctx } = await makeApp({ ctx: { roleRouters: { admin: probe, doctor: probe, patient: probe } } })
    await addUser(ctx, 'patient', 'p@test.local')
    await addUser(ctx, 'doctor', 'd@test.local')
    const patient = await login(app, 'p@test.local', 'password-123')
    const doctor = await login(app, 'd@test.local', 'password-123')
    const admin = await login(app, ADMIN.email, ADMIN.password)
    const anon = agentFor(app)

    expect((await anon.get('/api/admin/ping')).status).toBe(401)
    expect((await patient.get('/api/admin/ping')).status).toBe(403)
    expect((await doctor.get('/api/admin/ping')).status).toBe(403)
    expect((await admin.get('/api/admin/ping')).status).toBe(200)
    expect((await patient.get('/api/doctor/ping')).status).toBe(403)
    expect((await admin.get('/api/doctor/ping')).status).toBe(403)
    expect((await doctor.get('/api/patient/ping')).status).toBe(403)
    expect((await patient.get('/api/patient/ping')).status).toBe(200)
  })

  it('typing another role\'s page URL is refused', async () => {
    const { app, ctx } = await makeApp()
    await addUser(ctx, 'patient', 'p@test.local')
    await addUser(ctx, 'doctor', 'd@test.local')
    const patient = await login(app, 'p@test.local', 'password-123')
    const doctor = await login(app, 'd@test.local', 'password-123')
    const admin = await login(app, ADMIN.email, ADMIN.password)

    const anon = await agentFor(app).get('/admin/doctors')
    expect(anon.status).toBe(302)
    expect(anon.headers.location).toMatch(/^\/login\?next=/)
    expect((await patient.get('/admin')).status).toBe(403)
    expect((await patient.get('/doctor/today')).status).toBe(403)
    expect((await doctor.get('/admin')).status).toBe(403)
    expect((await doctor.get('/my/appointments')).status).toBe(403)
    expect((await admin.get('/doctor')).status).toBe(403)
    expect((await admin.get('/admin')).status).toBe(200)
    expect((await doctor.get('/doctor')).status).toBe(200)
    expect((await patient.get('/my')).status).toBe(200)
  })

  it('deactivated users cannot sign in and lose their sessions', async () => {
    const { app, ctx, db } = await makeApp()
    const id = await addUser(ctx, 'doctor', 'd@test.local')
    const doctor = await login(app, 'd@test.local', 'password-123')
    expect((await doctor.get('/api/auth/me')).body.user.role).toBe('doctor')
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id)
    expect((await doctor.get('/api/auth/me')).body.user).toBeNull()
    const again = await agentFor(app).post('/api/auth/login').send({ email: 'd@test.local', password: 'password-123' })
    expect(again.status).toBe(401)
  })

  it('logout ends the session', async () => {
    const { app } = await makeApp()
    const admin = await login(app, ADMIN.email, ADMIN.password)
    await admin.post('/api/auth/logout')
    expect((await admin.get('/api/auth/me')).body.user).toBeNull()
  })

  it('rate-limits repeated failed logins', async () => {
    const { app } = await makeApp({ config: { loginRateLimit: { windowMs: 60000, max: 3 } } })
    const agent = agentFor(app)
    for (let i = 0; i < 3; i++) expect((await agent.post('/api/auth/login').send({ email: ADMIN.email, password: 'wrong-wrong-1' })).status).toBe(401)
    expect((await agent.post('/api/auth/login').send({ email: ADMIN.email, password: 'wrong-wrong-1' })).status).toBe(429)
  })

  it('refuses cross-site writes', async () => {
    const { app } = await makeApp()
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: ADMIN.email, password: ADMIN.password })
    expect(res.status).toBe(403)
  })
})

describe('patient sign-up and email verification', () => {
  it('signs up, emails a link, and verifies once', async () => {
    const { app, emails, db } = await makeApp()
    const agent = agentFor(app)
    const res = await agent.post('/api/auth/signup').send({ name: 'Asha Test', email: 'asha@test.local', password: 'long-enough-1' })
    expect(res.status).toBe(201)
    expect(res.body.user.emailVerified).toBe(false)
    expect(emails.sent).toHaveLength(1)
    expect(emails.sent[0].to).toBe('asha@test.local')

    const token = linkToken(emails.sent[0].body)
    expect((await agent.post('/api/auth/verify-email').send({ token })).status).toBe(200)
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true)
    expect((await agent.post('/api/auth/verify-email').send({ token })).status).toBe(400) // single use
    expect(db.prepare("SELECT status FROM deliveries WHERE type = 'verify_email'").get().status).toBe('sent')
  })

  it('rejects weak passwords and duplicate emails', async () => {
    const { app } = await makeApp()
    const weak = await agentFor(app).post('/api/auth/signup').send({ name: 'Asha', email: 'a@test.local', password: 'short' })
    expect(weak.status).toBe(400)
    await agentFor(app).post('/api/auth/signup').send({ name: 'Asha', email: 'a@test.local', password: 'long-enough-1' })
    const dup = await agentFor(app).post('/api/auth/signup').send({ name: 'Asha', email: 'A@test.local', password: 'long-enough-1' })
    expect(dup.status).toBe(409)
  })

  it('records the email as skipped when email is not set up, and still lets the patient in', async () => {
    const { app, db } = await makeApp({ noEmail: true })
    const res = await agentFor(app).post('/api/auth/signup').send({ name: 'Asha', email: 'a@test.local', password: 'long-enough-1' })
    expect(res.status).toBe(201)
    expect(db.prepare("SELECT status FROM deliveries WHERE type = 'verify_email'").get().status).toBe('skipped')
  })

  it('a failed send is recorded as failed', async () => {
    const { app, db, emails } = await makeApp()
    emails.failNext = true
    await agentFor(app).post('/api/auth/signup').send({ name: 'Asha', email: 'a@test.local', password: 'long-enough-1' })
    expect(db.prepare("SELECT status FROM deliveries WHERE type = 'verify_email'").get().status).toBe('failed')
  })

  it('expired verification links are refused', async () => {
    const { app, ctx } = await makeApp()
    const id = await addUser(ctx, 'patient', 'p@test.local', 'password-123', { unverified: true })
    const t = issueToken(ctx.db, id, 'verify_email', new Date(Date.now() - 49 * 3600000))
    expect((await agentFor(app).post('/api/auth/verify-email').send({ token: t.token })).status).toBe(400)
  })
})

describe('doctor set-password link', () => {
  it('lets a doctor choose a password once, within 48 hours', async () => {
    const { app, ctx } = await makeApp()
    const id = ctx.db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('doctor','d@test.local','Dr Test',?)").run(new Date().toISOString()).lastInsertRowid
    const t = issueToken(ctx.db, Number(id), 'set_password')
    const agent = agentFor(app)
    expect((await agent.get(`/api/auth/set-password-info?token=${encodeURIComponent(t.token)}`)).body.name).toBe('Dr Test')
    expect((await agent.post('/api/auth/login').send({ email: 'd@test.local', password: 'new-password-1' })).status).toBe(401)
    expect((await agent.post('/api/auth/set-password').send({ token: t.token, password: 'short' })).status).toBe(400)
    expect((await agent.post('/api/auth/set-password').send({ token: t.token, password: 'new-password-1' })).status).toBe(200)
    expect((await agent.post('/api/auth/set-password').send({ token: t.token, password: 'other-password-1' })).status).toBe(400)
    expect((await agent.post('/api/auth/login').send({ email: 'd@test.local', password: 'new-password-1' })).status).toBe(200)
  })

  it('expires after 48 hours', async () => {
    const { app, ctx } = await makeApp()
    const id = ctx.db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('doctor','d@test.local','Dr Test',?)").run(new Date().toISOString()).lastInsertRowid
    const t = issueToken(ctx.db, Number(id), 'set_password', new Date(Date.now() - 49 * 3600000))
    expect((await agentFor(app).post('/api/auth/set-password').send({ token: t.token, password: 'new-password-1' })).status).toBe(400)
  })

  it('a new link cancels the older one', async () => {
    const { app, ctx } = await makeApp()
    const id = Number(ctx.db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('doctor','d@test.local','Dr Test',?)").run(new Date().toISOString()).lastInsertRowid)
    const first = issueToken(ctx.db, id, 'set_password')
    issueToken(ctx.db, id, 'set_password')
    expect((await agentFor(app).post('/api/auth/set-password').send({ token: first.token, password: 'new-password-1' })).status).toBe(400)
  })
})
