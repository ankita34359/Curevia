import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { createViaSocketService, replyProblem } from '../server/services/viasocket.js'
import { loadConfig } from '../server/config.js'

const FRI_9 = '2026-10-23T03:30:00.000Z' // Fri 23 Oct 2026, 09:00 IST
const book = (doctorId, startUtc = FRI_9) => ({ doctorId, startUtc, name: 'Asha Test', age: 31, gender: 'female', phone: '+91 90000 00000', email: 'asha@test.local', reason: 'Fake: cough' })

async function setup(opts) {
  const ctx = await makeApp(opts)
  const doc = addDoctor(ctx.db)
  addPatient(ctx.db)
  const patient = await login(ctx.app, 'pat@test.local', 'password-123')
  const doctor = await login(ctx.app, 'doc@test.local', 'password-123')
  const admin = await login(ctx.app, ADMIN.email, ADMIN.password)
  return { ...ctx, ...doc, patient, doctor, admin }
}
const delivery = (db, where) => db.prepare(`SELECT * FROM deliveries WHERE ${where}`).all()

describe('embed token', () => {
  it('is an HS256 JWT with exactly org_id, project_id and unique_identifier, signed with the secret', async () => {
    const config = loadConfig({ SESSION_SECRET: 'x'.repeat(20), ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'pass-12345', VIASOCKET_ORG_ID: '80141', VIASOCKET_PROJECT_ID: 'projKcrymrh3', VIASOCKET_EMBED_SECRET: 'unit-test-secret', VIASOCKET_UNIQUE_ID: 'curevia-hospital' })
    const token = await createViaSocketService({ config }).embedToken() // the real viasocket-apps signer, fake secret
    const [h, p, sig] = token.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url'))).toEqual({ org_id: '80141', project_id: 'projKcrymrh3', unique_identifier: 'curevia-hospital' })
    expect(crypto.createHmac('sha256', 'unit-test-secret').update(`${h}.${p}`).digest('base64url')).toBe(sig)
  })

  it('is only given to the admin, and says which variables are missing when not configured', async () => {
    const { admin, patient, doctor } = await setup()
    expect((await admin.get('/api/admin/integrations/embed')).body.token).toBe('fake-token-for-curevia-test')
    await patient.get('/api/admin/integrations/embed').expect(403)
    await doctor.get('/api/admin/integrations/embed').expect(403)
    const blank = await makeApp({ config: { viasocket: { orgId: '', projectId: '', embedSecret: '', uniqueId: 'curevia-hospital' } } })
    const a = await login(blank.app, ADMIN.email, ADMIN.password)
    const res = await a.get('/api/admin/integrations/embed')
    expect(res.status).toBe(503)
    expect(res.body.missing).toEqual(['VIASOCKET_ORG_ID', 'VIASOCKET_PROJECT_ID', 'VIASOCKET_EMBED_SECRET'])
    expect(JSON.stringify(res.body)).not.toMatch(/secret-for-tests/)
  })
})

describe('reply body check', () => {
  it('treats an error inside an HTTP 200 reply as a failure', () => {
    expect(replyProblem({ ok: true })).toBeNull()
    expect(replyProblem({ appendedRows: 1 })).toBeNull()
    expect(replyProblem(null)).toBeNull()
    expect(replyProblem({ error: {} })).toMatch(/failed/) // a failed step becomes { error: {} }
    expect(replyProblem({ error: { message: 'Invalid grant' } })).toMatch(/Invalid grant/)
    expect(replyProblem({ success: false, message: 'Auth expired' })).toMatch(/Auth expired/)
    expect(replyProblem({ data: { success: false, message: 'Nope' } })).toMatch(/Nope/)
    expect(replyProblem({ status: 400, message: 'Flow is currently paused' })).toMatch(/paused/)
    expect(replyProblem({ step1: { ok: 1 }, send_mail: { error: { message: 'quota' } } })).toMatch(/quota/)
    expect(replyProblem('Error: boom')).toMatch(/boom/)
    expect(replyProblem({ error: null })).toBeNull()
  })

  it('a flow that answers 200 with an error is recorded as failed, not sent', async () => {
    const { patient, doctorId, db, fake, notifier } = await setup()
    fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 200, body: { error: { message: 'Gmail quota exceeded' } } } : undefined)
    await patient.post('/api/patient/appointments').send(book(doctorId)).expect(201)
    await notifier.flush()
    const mails = delivery(db, "channel = 'email' AND type IN ('patient_request_received','doctor_new_request')")
    expect(mails).toHaveLength(2)
    expect(mails.every((m) => m.status === 'failed')).toBe(true)
    expect(mails[0].error).toMatch(/Gmail quota exceeded/)
    expect(delivery(db, "channel = 'sheet'")[0].status).toBe('sent') // the other slot is unaffected
  })

  it('HTTP errors are failures too, and a paused flow marks the slot paused', async () => {
    const { patient, doctorId, db, fake, notifier, services } = await setup()
    fake.nextReply = { status: 400, body: { message: 'Flow is currently paused' } }
    await patient.post('/api/patient/appointments').send(book(doctorId)).expect(201)
    await notifier.flush()
    expect(delivery(db, "status = 'failed'").length).toBeGreaterThan(0)
    const paused = ['appointments_sheet', 'email_sender'].filter((s) => services.integrations.get(s).status === 'paused')
    expect(paused.length).toBe(1)
  })
})

describe('integration events', () => {
  const published = (fake, id, webhook) => fake.flows.push({ id, title: 'My flow', status: 'active', webhook, description: '', authId: 'a', serviceId: 's' })

  it('stores the flow address read from viaSocket, never one sent by the browser, and never shows it back', async () => {
    const { admin, fake } = await setup({ off: ['slack_alert'] })
    published(fake, 'flowSlack1', 'https://flow.sokt.io/func/flowSlack1')
    const res = await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'flowSlack1', action: 'published', webhookurl: 'https://evil.example/steal' })
    expect(res.status).toBe(200)
    expect(res.body.slot.status).toBe('active')
    expect(res.body.slot.flowId).toBe('flowSlack1')
    const everything = JSON.stringify([res.body, (await admin.get('/api/admin/integrations')).body])
    expect(everything).not.toMatch(/flow\.sokt\.io|evil\.example|webhook/i)
  })

  it('refuses unknown flows, flows used by another slot, and addresses that are not viaSocket flow URLs', async () => {
    const { admin, fake } = await setup({ off: ['slack_alert'] })
    await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'nothingHere', action: 'published' }).expect(409)
    await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'test-email_sender', action: 'published' }).expect(409)
    published(fake, 'badFlow1', 'https://evil.example/func/badFlow1')
    await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'badFlow1', action: 'published' }).expect(502)
    await admin.post('/api/admin/integrations/nope/event').send({ flowId: 'abcd', action: 'published' }).expect(404)
  })

  it('remembers drafts so the slot reopens its own flow, and handles paused / deleted', async () => {
    const { admin, fake } = await setup({ off: ['slack_alert'] })
    let s = (await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'draft12345', action: 'initiated' })).body.slot
    expect([s.status, s.flowId]).toEqual(['drafted', 'draft12345'])
    // a second "initiated" for the same slot must not replace the existing flow with a new draft
    s = (await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'another1234', action: 'initiated' })).body.slot
    expect(s.flowId).toBe('draft12345')
    published(fake, 'draft12345', 'https://flow.sokt.io/func/draft12345')
    expect((await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'draft12345', action: 'published' })).body.slot.status).toBe('active')
    fake.flows[fake.flows.length - 1].status = 'paused'
    expect((await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'draft12345', action: 'paused' })).body.slot.status).toBe('paused')
    expect((await admin.post('/api/admin/integrations/slack_alert/event').send({ flowId: 'draft12345', action: 'deleted' })).body.slot).toMatchObject({ status: 'none', flowId: null })
  })

  it('only the admin can use the integration endpoints', async () => {
    const { patient, doctor } = await setup()
    for (const a of [patient, doctor]) {
      await a.get('/api/admin/integrations').expect(403)
      await a.post('/api/admin/integrations/slack_alert/test').expect(403)
    }
  })

  it('test buttons send one harmless message per slot and report failures', async () => {
    const { admin, fake, db } = await setup()
    for (const slot of ['appointments_sheet', 'email_sender', 'slack_alert']) {
      const r = await admin.post(`/api/admin/integrations/${slot}/test`)
      expect(r.body.result).toBe('sent')
    }
    expect(fake.postsTo('appointments_sheet')[0]).toMatchObject({ patient_name: 'Test Patient (fake)', event: 'test' })
    expect(fake.postsTo('email_sender')[0]).toMatchObject({ to: ADMIN.email, subject: 'Curevia test email' })
    expect(fake.postsTo('slack_alert')[0].text).toMatch(/Slack alerts work/)
    fake.nextReply = { status: 200, body: { success: false, message: 'channel_not_found' } }
    const bad = await admin.post('/api/admin/integrations/slack_alert/test')
    expect(bad.body.result).toBe('failed')
    expect(bad.body.error).toMatch(/channel_not_found/)
    expect(db.prepare("SELECT COUNT(*) n FROM deliveries WHERE type = 'test'").get().n).toBe(4)
  })
})

describe('emails and the sheet', () => {
  it('a booking adds a sheet row with every field and emails the patient and the doctor, once', async () => {
    const { patient, doctorId, fake, notifier, emails, db } = await setup()
    await patient.post('/api/patient/appointments').send(book(doctorId)).expect(201)
    await notifier.flush()
    const rows = fake.postsTo('appointments_sheet')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      appointment_id: 1, patient_name: 'Asha Test', age: 31, gender: 'female', phone: '+91 90000 00000', email: 'asha@test.local', reason: 'Fake: cough',
      doctor: 'Dr Test', department: 'General', date: '23 Oct 2026', time: '9:00 AM', status: 'pending', event: 'booked', at: '22 Oct 2026, 9:30 AM'
    })
    const sent = emails.sent
    expect(sent.map((m) => m.to).sort()).toEqual(['asha@test.local', 'doc@test.local'])
    const toPatient = sent.find((m) => m.to === 'asha@test.local')
    expect(toPatient.subject).toBe('We received your appointment request for 23 Oct 2026, 9:00 AM')
    expect(toPatient.body).toContain('pending')
    expect(sent.find((m) => m.to === 'doc@test.local').body).toContain('Fake: cough')
    expect(delivery(db, "status = 'sent'")).toHaveLength(3)
  })

  it('every status change adds a sheet row, and emails follow the brief', async () => {
    const { patient, doctor, admin, doctorId, fake, notifier, emails, clock } = await setup()
    const id = (await patient.post('/api/patient/appointments').send(book(doctorId))).body.appointment.id
    await doctor.post(`/api/doctor/appointments/${id}/confirm`).expect(200)
    clock.now = new Date('2026-10-23T03:45:00.000Z')
    await doctor.post(`/api/doctor/appointments/${id}/complete`).expect(200)
    await notifier.flush()
    expect(fake.postsTo('appointments_sheet').map((r) => [r.event, r.status])).toEqual([['booked', 'pending'], ['confirmed', 'confirmed'], ['completed', 'completed']])
    expect(emails.sent.filter((m) => m.subject.startsWith('Your appointment is confirmed'))).toHaveLength(1)
    expect(emails.sent).toHaveLength(4) // request received, doctor request, confirmed, and (since Phase 2) "How was your visit?" when the visit is completed
    expect(emails.sent[3]).toMatchObject({ to: 'asha@test.local' })
    expect(emails.sent[3].subject).toMatch(/^How was your visit with /)
  })

  it('patient cancel emails both sides; doctor cancel emails the patient with the reason', async () => {
    const { patient, doctor, doctorId, db, notifier, emails } = await setup()
    const a = (await patient.post('/api/patient/appointments').send(book(doctorId))).body.appointment.id
    const b = (await patient.post('/api/patient/appointments').send(book(doctorId, '2026-10-23T04:00:00.000Z'))).body.appointment.id
    await patient.post(`/api/patient/appointments/${a}/cancel`).send({ reason: 'Feeling better' }).expect(200)
    await doctor.post(`/api/doctor/appointments/${b}/cancel`).send({ reason: 'Emergency surgery', offerRebooking: false }).expect(200)
    await notifier.flush()
    const cancelled = emails.sent.filter((m) => /was cancelled|cancelled by the patient/.test(m.subject))
    expect(cancelled.map((m) => m.to).sort()).toEqual(['asha@test.local', 'asha@test.local', 'doc@test.local'])
    expect(cancelled.find((m) => m.body.includes('Emergency surgery')).to).toBe('asha@test.local')
    expect(cancelled.find((m) => m.to === 'doc@test.local').body).toContain('Feeling better')
  })

  it('needs_rebooking emails slot options in India time and a link to pick one', async () => {
    const { patient, admin, db, doctorId, notifier, emails, config } = await setup()
    addDoctor(db, { email: 'doc2@test.local', name: 'Dr Second' })
    const id = (await patient.post('/api/patient/appointments').send(book(doctorId))).body.appointment.id
    await notifier.flush()
    await admin.post(`/api/admin/doctors/${doctorId}/deactivate`).expect(200)
    await notifier.flush()
    const mail = emails.sent.find((m) => m.subject === 'Please choose a new time for your appointment')
    expect(mail.to).toBe('asha@test.local')
    expect(mail.body).toContain('Dr Second')
    expect(mail.body).toMatch(/\d{1,2} Oct 2026, \d{1,2}:\d{2} (AM|PM)/)
    expect(mail.body).toContain(`${config.appUrl}/my/rebook/${id}`)
  })

  it('a rebooked confirmed appointment gets a confirmation email, not a new request', async () => {
    const { patient, doctor, admin, db, doctorId, notifier, emails } = await setup()
    const second = addDoctor(db, { email: 'doc2@test.local', name: 'Dr Second' })
    const id = (await patient.post('/api/patient/appointments').send(book(doctorId))).body.appointment.id
    await doctor.post(`/api/doctor/appointments/${id}/confirm`)
    await admin.post(`/api/admin/doctors/${doctorId}/deactivate`)
    const opt = (await patient.get(`/api/patient/appointments/${id}/rebook-options`)).body.options[0]
    const res = await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: opt.doctorId, startUtc: opt.startUtc })
    await notifier.flush()
    expect(res.body.appointment.status).toBe('confirmed')
    expect(emails.sent.filter((m) => m.subject.startsWith('Your appointment is confirmed')).map((m) => m.body).some((b) => b.includes('Dr Second'))).toBe(true)
    expect(second.doctorId).toBeGreaterThan(0)
  })
})

describe('never twice, never silently lost', () => {
  it('replaying the same event sends nothing more', async () => {
    const { patient, doctorId, notifier, fake, emails } = await setup()
    await patient.post('/api/patient/appointments').send(book(doctorId))
    await notifier.flush()
    const before = [fake.posts.length, emails.sent.length]
    notifier.emit('booked', { appointmentId: 1 })
    notifier.emit('booked', { appointmentId: 1 })
    await notifier.flush()
    expect([fake.posts.length, emails.sent.length]).toEqual(before)
  })

  it('simultaneous identical sends result in one email', async () => {
    const { mailer, emails } = await setup()
    const msg = { type: 'x', dedupeKey: 'email:x:1', to: 'a@test.local', subject: 's', html: 'h' }
    const rs = await Promise.all([mailer.send(msg), mailer.send(msg), mailer.send(msg)])
    expect(emails.sent).toHaveLength(1)
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1)
  })

  it('a failed send can be retried and then succeeds once', async () => {
    const { mailer, emails, db } = await setup()
    emails.failNext = true
    const msg = { type: 'x', dedupeKey: 'email:x:2', to: 'a@test.local', subject: 's', html: 'h' }
    expect((await mailer.send(msg)).status).toBe('failed')
    expect((await mailer.send(msg)).status).toBe('sent')
    expect((await mailer.send(msg)).duplicate).toBe(true)
    expect(emails.sent).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) n FROM deliveries WHERE dedupe_key = 'email:x:2'").get().n).toBe(1)
  })

  it('with no email flow set up, emails are recorded as skipped, nothing is sent and bookings still work', async () => {
    const { patient, doctorId, notifier, db, fake } = await setup({ noEmail: true })
    await patient.post('/api/patient/appointments').send(book(doctorId)).expect(201)
    await notifier.flush()
    expect(delivery(db, "channel = 'email'").every((d) => d.status === 'skipped')).toBe(true)
    expect(fake.postsTo('email_sender')).toHaveLength(0)
    expect(fake.postsTo('appointments_sheet')).toHaveLength(1)
  })
})
