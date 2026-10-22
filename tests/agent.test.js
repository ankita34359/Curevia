import { describe, it, expect } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { fixedRules, validateDecision } from '../server/services/agent/policy.js'
import { rebookOptions } from '../server/services/scheduling.js'

const FRI_9 = '2026-10-23T03:30:00.000Z' // Fri 23 Oct 09:00 IST
const MIN = 60000
const iso = (ms) => new Date(ms).toISOString()

// One department with two doctors, a patient with a pending appointment created `ageMin` minutes before "now".
async function world({ ageMin = 180, startUtc = FRI_9, status = 'pending', noEmail = false, off } = {}) {
  const ctx = await makeApp({ noEmail, off })
  const a = addDoctor(ctx.db, { email: 'doc@test.local', name: 'Dr One' })
  const b = addDoctor(ctx.db, { email: 'doc2@test.local', name: 'Dr Two' })
  const patientId = addPatient(ctx.db)
  const id = addAppointment(ctx.db, { doctorId: a.doctorId, patientId, startUtc, status, name: 'Asha Secret' })
  ctx.db.prepare("UPDATE appointments SET created_at = ?, reason = 'Fake: private chest pain' WHERE id = ?").run(iso(ctx.clock.now.getTime() - ageMin * MIN), id)
  const admin = await login(ctx.app, ADMIN.email, ADMIN.password)
  const patient = await login(ctx.app, 'pat@test.local', 'password-123')
  return { ...ctx, a, b, id, patientId, admin, patient, advance: (min) => { ctx.clock.now = new Date(ctx.clock.now.getTime() + min * MIN) } }
}
const say = (content) => () => ({ content, finishReason: 'completed' })
const decision = (over) => ({ action: 'wait', reason: 'Because.', wait_minutes: 0, slot_option_ids: [], email_note: '', ...over })
const log = (db, id) => db.prepare('SELECT * FROM agent_log WHERE appointment_id = ? ORDER BY id').all(id)
const mailsTo = (emails, to) => emails.sent.filter((m) => m.to === to)

describe('guardrails (rules as code)', () => {
  const facts = (over = {}) => ({
    caseType: 'pending', minutesSinceCaseStart: 200, minutesUntilAppointment: 2000,
    counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 0, offers: 0 },
    minutesSinceLast: { remind_doctor: null, remind_patient: null, offer_slots_to_patient: null },
    options: [1, 2, 3, 4].map((i) => ({ id: i, doctorId: 2, doctorName: 'Dr Two', startUtc: `2026-10-2${i}T05:00:00.000Z`, startIst: 'x' })), ...over
  })
  const why = (raw, f) => validateDecision(raw, f).why

  it('allows at most 2 doctor reminders and 2 patient reminders', () => {
    expect(validateDecision({ action: 'remind_doctor' }, facts()).ok).toBe(true)
    expect(why({ action: 'remind_doctor' }, facts({ counts: { doctorReminders: 2, patientReminders: 0, adminAlerts: 0, offers: 0 } }))).toMatch(/already sent 2 doctor reminders/)
    expect(why({ action: 'remind_patient' }, facts({ counts: { doctorReminders: 0, patientReminders: 2, adminAlerts: 0, offers: 0 } }))).toMatch(/already sent 2 patient reminders/)
  })
  it('allows one admin alert per case', () => {
    expect(validateDecision({ action: 'alert_admin' }, facts()).ok).toBe(true)
    expect(why({ action: 'alert_admin' }, facts({ counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 1, offers: 0 } }))).toMatch(/already alerted/)
  })
  it('only offers up to 3 distinct slots, all taken from the free options it was given', () => {
    expect(validateDecision({ action: 'offer_slots_to_patient', slotOptionIds: [1, 2, 3] }, facts()).decision.options).toHaveLength(3)
    expect(why({ action: 'offer_slots_to_patient', slotOptionIds: [1, 2, 3, 4] }, facts())).toMatch(/more than 3/)
    expect(why({ action: 'offer_slots_to_patient', slotOptionIds: [1, 99] }, facts())).toMatch(/not one of the free options/)
    expect(why({ action: 'offer_slots_to_patient', slotOptionIds: [] }, facts())).toMatch(/no slots/)
    expect(validateDecision({ action: 'offer_slots_to_patient', slotOptionIds: [2, 2, 2] }, facts()).decision.options).toHaveLength(1)
  })
  it('enforces gaps, never reminds a doctor about a rebooking, and only closes after the admin was alerted', () => {
    expect(why({ action: 'remind_doctor' }, facts({ minutesSinceLast: { remind_doctor: 10, remind_patient: null, offer_slots_to_patient: null } }))).toMatch(/less than an hour/)
    expect(why({ action: 'remind_doctor' }, facts({ caseType: 'needs_rebooking' }))).toMatch(/pending request/)
    expect(why({ action: 'close_case' }, facts())).toMatch(/after the admin has been alerted/)
    expect(validateDecision({ action: 'close_case' }, facts({ counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 1, offers: 0 } })).ok).toBe(true)
    expect(why({ action: 'book_for_patient' }, facts())).toMatch(/unknown action/)
  })
  it('clamps wait to 5 minutes..12 hours', () => {
    expect(validateDecision({ action: 'wait', waitMinutes: 1 }, facts()).decision.waitMinutes).toBe(5)
    expect(validateDecision({ action: 'wait', waitMinutes: 99999 }, facts()).decision.waitMinutes).toBe(720)
  })
  it('strips HTML and links from the AI\'s email note', () => {
    expect(validateDecision({ action: 'offer_slots_to_patient', slotOptionIds: [1], emailNote: 'We found <b>new</b> times for you.' }, facts()).decision.note).toBe('We found new times for you.')
    expect(validateDecision({ action: 'offer_slots_to_patient', slotOptionIds: [1], emailNote: 'Click https://evil.example now' }, facts()).decision.note).toBe('')
  })
  it('fixed rules follow the defaults: doctor reminder at 2 h, admin alert at 6 h, offer slots when under 12 h away', () => {
    expect(fixedRules(facts({ minutesSinceCaseStart: 60 })).action).toBe('wait')
    expect(fixedRules(facts({ minutesSinceCaseStart: 125 })).action).toBe('remind_doctor')
    expect(fixedRules(facts({ minutesSinceCaseStart: 365 })).action).toBe('alert_admin')
    const near = fixedRules(facts({ minutesSinceCaseStart: 130, minutesUntilAppointment: 600 }))
    expect(near.action).toBe('offer_slots_to_patient')
    expect(near.options.length).toBeLessThanOrEqual(3)
    expect(fixedRules(facts({ caseType: 'needs_rebooking', minutesSinceCaseStart: 1 })).action).toBe('offer_slots_to_patient')
  })
})

describe('agent', () => {
  it('asks the AI with scheduling facts only, and does what the AI chose (remind the doctor)', async () => {
    const w = await world()
    w.fake.ai = say(decision({ action: 'remind_doctor', reason: 'Unconfirmed for 3 hours, over the 2 hour default.' }))
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ cases: 1, actions: 1, fallbacks: 0 })
    const req = w.fake.aiCalls[0]
    expect(req).toMatchObject({ responseType: 'json_schema', service: 'openai', model: 'gpt-5-mini', threadId: `agent-case-${w.id}` })
    expect(req.jsonSchema.strict).toBe(true)
    expect(req.message).not.toMatch(/Asha|chest pain|90000|asha@|pat@/i) // no patient details leave the server
    expect(JSON.parse(req.message)).toMatchObject({ case_type: 'pending', doctor: 'Dr One', minutes_since_case_started: 180 })
    expect(mailsTo(w.emails, 'doc@test.local').some((m) => m.subject.startsWith('Reminder: appointment request still waiting'))).toBe(true)
    const [row] = log(w.db, w.id)
    expect(row).toMatchObject({ source: 'ai', action: 'remind_doctor', executed: 1, outcome: 'sent' })
    expect(row.reason).toMatch(/3 hours/)
  })

  it('refuses a third doctor reminder and falls back to the fixed rules, logging both', async () => {
    const w = await world({ ageMin: 300 })
    w.fake.ai = say(decision({ action: 'remind_doctor', reason: 'Nudge again.' }))
    await w.tick.run()
    w.advance(61)
    await w.tick.run()
    w.advance(61)
    const r = await w.tick.run() // third attempt: refused by the 2-reminder limit
    expect(r.agent.fallbacks).toBe(1)
    const rows = log(w.db, w.id)
    expect(rows.filter((x) => x.action === 'remind_doctor' && x.executed === 1)).toHaveLength(2)
    expect(rows.some((x) => x.executed === 0 && /already sent 2 doctor reminders/.test(x.outcome))).toBe(true)
    expect(mailsTo(w.emails, 'doc@test.local').filter((m) => /Reminder: appointment request/.test(m.subject))).toHaveLength(2)
  })

  it('never offers a slot that was not in the free options, and never one that has since been taken', async () => {
    const w = await world({ ageMin: 130, startUtc: '2026-10-22T10:30:00.000Z' }) // under 12 h away
    w.fake.ai = say(decision({ action: 'offer_slots_to_patient', slot_option_ids: [1, 999], reason: 'Offer.' }))
    await w.tick.run()
    expect(log(w.db, w.id)[0]).toMatchObject({ source: 'ai', executed: 0 })
    expect(log(w.db, w.id)[0].outcome).toMatch(/not one of the free options/)
    // a valid offer, but option 1 is booked by someone else after the AI looked at it and before the email goes out
    const w2 = await world({ ageMin: 130, startUtc: '2026-10-22T10:30:00.000Z' })
    w2.fake.ai = () => {
      const appt = w2.db.prepare('SELECT * FROM appointments WHERE id = ?').get(w2.id)
      const first = rebookOptions(w2.db, appt, w2.clock.now.toISOString(), { limit: 8, perDoctor: 4, leadMinutes: 60 })[0]
      addAppointment(w2.db, { doctorId: first.doctorId, patientId: addPatient(w2.db, 'rival@test.local', 'Rival'), startUtc: first.startUtc })
      return { content: decision({ action: 'offer_slots_to_patient', slot_option_ids: [1, 2, 3], email_note: 'We found other times.' }), finishReason: 'completed' }
    }
    await w2.tick.run()
    const sent = mailsTo(w2.emails, 'pat@test.local').find((m) => m.subject === 'Other times are available for your appointment')
    expect(sent.body).toContain('We found other times.')
    expect(sent.body).toContain(`${w2.config.appUrl}/my/rebook/${w2.id}`)
    expect((sent.body.match(/<li>/g) || []).length).toBe(2) // the taken slot was dropped, the other two are still free
  })

  it('never books, confirms or cancels anything for the patient', async () => {
    const w = await world({ ageMin: 400, startUtc: '2026-10-22T10:30:00.000Z' })
    const before = w.db.prepare('SELECT id, status, start_utc, doctor_id FROM appointments ORDER BY id').all()
    for (const action of ['remind_doctor', 'offer_slots_to_patient', 'alert_admin', 'remind_patient', 'wait', 'close_case']) {
      w.fake.ai = say(decision({ action, slot_option_ids: [1, 2, 3], wait_minutes: 10 }))
      await w.tick.run()
      w.advance(130)
    }
    expect(w.db.prepare('SELECT id, status, start_utc, doctor_id FROM appointments ORDER BY id').all()).toEqual(before)
    expect(w.db.prepare("SELECT COUNT(*) n FROM appointments WHERE status = 'rebooked'").get().n).toBe(0)
  })

  it('alerts the admin at most once per case, in Slack, without patient details', async () => {
    const w = await world({ ageMin: 400 })
    w.fake.ai = say(decision({ action: 'alert_admin', reason: 'Over 6 hours.' }))
    await w.tick.run()
    w.advance(130)
    await w.tick.run()
    w.advance(130)
    await w.tick.run()
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
    const text = w.fake.postsTo('slack_alert')[0].text
    expect(text).toContain(`appointment #${w.id}`)
    expect(text).not.toMatch(/Asha|chest|90000/)
    expect(log(w.db, w.id).filter((x) => x.action === 'alert_admin' && x.executed === 1)).toHaveLength(1)
  })

  it('stops when the case is resolved: no more AI calls, the case is closed and logged', async () => {
    const w = await world()
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 5 }))
    await w.tick.run()
    const doctor = await login(w.app, 'doc@test.local', 'password-123')
    await doctor.post(`/api/doctor/appointments/${w.id}/confirm`).expect(200)
    w.advance(10)
    const calls = w.fake.aiCalls.length
    await w.tick.run()
    expect(w.fake.aiCalls.length).toBe(calls)
    const closed = w.db.prepare('SELECT * FROM agent_cases WHERE appointment_id = ?').get(w.id)
    expect(closed.closed_reason).toBe('resolved')
    expect(log(w.db, w.id).at(-1)).toMatchObject({ source: 'guard', action: 'close_case' })
    expect(log(w.db, w.id).at(-1).reason).toMatch(/now confirmed/)
  })

  it('waits as asked and does not call the AI again until the wait is over', async () => {
    const w = await world()
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 60, reason: 'Too early to act.' }))
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(1)
    w.advance(5)
    await w.tick.run()
    w.advance(5)
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(1)
    w.advance(55)
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(2)
  })

  it('does not look at a request younger than 30 minutes', async () => {
    const w = await world({ ageMin: 10 })
    w.fake.ai = say(decision({ action: 'remind_doctor' }))
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(0)
    expect(log(w.db, w.id)).toHaveLength(0)
  })

  it('falls back to fixed rules when the AI fails, and logs why', async () => {
    for (const ai of [null, () => { throw new Error('502 from viaSocket') }, say('not an object'), say({ nonsense: true }), say(decision({ action: 'dance' }))]) {
      const w = await world({ ageMin: 130 })
      w.fake.ai = ai
      const r = await w.tick.run()
      expect(r.agent.fallbacks).toBe(1)
      const row = log(w.db, w.id).at(-1)
      expect(row).toMatchObject({ source: 'fallback', action: 'remind_doctor', executed: 1 })
      expect(row.reason).toMatch(/^Fixed rule:/)
      expect(row.ai_error).toBeTruthy()
    }
  })

  it('does not leave an old case with nobody told, even if the AI keeps saying wait', async () => {
    const w = await world({ ageMin: 400 })
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 30, reason: 'Fine.' }))
    await w.tick.run()
    expect(log(w.db, w.id)[0]).toMatchObject({ source: 'guard', action: 'alert_admin', executed: 1 })
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
  })

  it('a needs_rebooking case: offers the earliest free slots, the patient picks one, the case closes', async () => {
    const w = await world({ status: 'needs_rebooking', ageMin: 60 })
    w.db.prepare("INSERT INTO appointment_events (appointment_id, event, to_status, actor_role, created_at) VALUES (?, 'needs_rebooking', 'needs_rebooking', 'doctor', ?)").run(w.id, iso(w.clock.now.getTime() - 5 * MIN))
    w.fake.ai = (req) => ({ content: decision({ action: 'offer_slots_to_patient', slot_option_ids: [1, 2, 3], email_note: 'Sorry for the change. Here are some other times.', reason: 'Earliest free slots.' }), finishReason: 'completed' })
    await w.tick.run()
    const mail = mailsTo(w.emails, 'pat@test.local').find((m) => m.subject === 'Other times are available for your appointment')
    expect(mail).toBeTruthy()
    const picked = (await w.patient.get(`/api/patient/appointments/${w.id}/rebook-options`)).body.options[0]
    await w.patient.post(`/api/patient/appointments/${w.id}/rebook`).send({ doctorId: picked.doctorId, startUtc: picked.startUtc }).expect(201)
    w.advance(130)
    await w.tick.run()
    expect(w.db.prepare("SELECT closed_reason FROM agent_cases WHERE appointment_id = ? AND case_type = 'needs_rebooking'").get(w.id).closed_reason).toBe('resolved')
  })

  it('admin sees open cases and every decision with its reason, and can run "Check now"', async () => {
    const w = await world({ ageMin: 130 })
    w.fake.ai = say(decision({ action: 'remind_doctor', reason: 'Two hours without an answer.' }))
    const r = await w.admin.post('/api/admin/agent/check-now')
    expect(r.body.result.agent.actions).toBe(1)
    const page = (await w.admin.get('/api/admin/agent')).body
    expect(page.openCases).toHaveLength(1)
    expect(page.openCases[0]).toMatchObject({ appointmentId: w.id, caseType: 'pending', doctor: 'Dr One', done: { doctorReminders: 1, adminAlerted: false } })
    expect(page.decisions[0]).toMatchObject({ action: 'remind_doctor', reason: 'Two hours without an answer.', source: 'ai', executed: true })
    await w.patient.get('/api/admin/agent').expect(403)
    await w.patient.post('/api/admin/agent/check-now').expect(403)
  })

  it('works without viaSocket set up: fixed rules run and the sends are skipped, not lost', async () => {
    const w = await world({ ageMin: 130, off: ['slack_alert', 'email_sender', 'appointments_sheet'] })
    w.fake.ai = null
    await w.tick.run()
    expect(log(w.db, w.id)[0]).toMatchObject({ source: 'fallback', action: 'remind_doctor' })
    expect(w.db.prepare("SELECT status FROM deliveries WHERE type = 'agent_remind_doctor'").get().status).toBe('skipped')
  })
})

describe('cron route and reminders', () => {
  const CRON = { config: { cronSecret: 'cron-secret-for-tests' } }
  it('401 without the right bearer token, for GET and POST; 202 with it', async () => {
    const { app } = await makeApp(CRON)
    const a = agentFor(app)
    for (const m of ['get', 'post']) {
      await a[m]('/api/cron/tick').expect(401)
      await a[m]('/api/cron/tick').set('Authorization', 'Bearer wrong').expect(401)
      await a[m]('/api/cron/tick').set('Authorization', 'cron-secret-for-tests').expect(401)
      const ok = await a[m]('/api/cron/tick').set('Authorization', 'Bearer cron-secret-for-tests')
      expect(ok.status).toBe(202)
      expect(ok.body).toMatchObject({ accepted: true })
    }
  })
  it('always 401 when CRON_SECRET is not set (even for "Bearer ")', async () => {
    const { app } = await makeApp()
    await agentFor(app).post('/api/cron/tick').set('Authorization', 'Bearer ').expect(401)
    await agentFor(app).post('/api/cron/tick').set('Authorization', 'Bearer undefined').expect(401)
  })

  async function confirmed({ confirmedAgoMin, startInMin }) {
    const ctx = await makeApp(CRON)
    const { doctorId } = addDoctor(ctx.db)
    const p = addPatient(ctx.db)
    const start = iso(ctx.clock.now.getTime() + startInMin * MIN)
    const id = addAppointment(ctx.db, { doctorId, patientId: p, startUtc: start, status: 'confirmed' })
    ctx.db.prepare('UPDATE appointments SET confirmed_at = ? WHERE id = ?').run(iso(ctx.clock.now.getTime() - confirmedAgoMin * MIN), id)
    return { ...ctx, id }
  }
  const reminders = (emails) => emails.sent.filter((m) => /^Reminder: your appointment/.test(m.subject))

  it('sends the 24 h and the 1 h reminder once each, even if the tick runs many times or twice at once', async () => {
    const c = await confirmed({ confirmedAgoMin: 3000, startInMin: 23 * 60 })
    await Promise.all([c.tick.run(), c.tick.run(), c.tick.run()])
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(1)
    expect(reminders(c.emails)[0].subject).toMatch(/tomorrow, 23 Oct 2026/)
    c.clock.now = new Date(c.clock.now.getTime() + 22.5 * 60 * MIN) // now 30 minutes before
    await c.tick.run()
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(2)
    expect(reminders(c.emails)[1].subject).toMatch(/in about 1 hour/)
    expect(c.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE type LIKE 'reminder_%' AND status = 'sent'").get().n).toBe(2)
  })
  it('only confirmed appointments get reminders, and never right after the confirmation email', async () => {
    const c = await confirmed({ confirmedAgoMin: 30, startInMin: 23 * 60 }) // confirmed 30 min ago, so no "24 h" reminder
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(0)
    c.db.prepare("UPDATE appointments SET status = 'pending'").run()
    c.clock.now = new Date(c.clock.now.getTime() + 22.5 * 60 * MIN)
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(0)
    const cancelled = await confirmed({ confirmedAgoMin: 3000, startInMin: 30 })
    cancelled.db.prepare("UPDATE appointments SET status = 'cancelled_by_patient'").run()
    await cancelled.tick.run()
    expect(reminders(cancelled.emails)).toHaveLength(0)
  })
  it('a reminder that failed to send is tried again on the next tick, and still sent only once', async () => {
    const c = await confirmed({ confirmedAgoMin: 3000, startInMin: 120 })
    c.clock.now = new Date(c.clock.now.getTime() + 70 * MIN) // 50 min before: 1 h reminder due
    c.emails.failNext = true
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(0)
    await c.tick.run()
    await c.tick.run()
    expect(reminders(c.emails)).toHaveLength(1)
  })
  it('retries a failed event email on a later tick', async () => {
    const ctx = await makeApp(CRON)
    const { doctorId } = addDoctor(ctx.db)
    addPatient(ctx.db)
    const patient = await login(ctx.app, 'pat@test.local', 'password-123')
    ctx.emails.failNext = true // the first email of the booking fails
    await patient.post('/api/patient/appointments').send({ doctorId, startUtc: FRI_9, name: 'A B', age: 30, gender: 'female', phone: '+91 90000 00000', email: 'pat@test.local', reason: 'Fake' }).expect(201)
    await ctx.notifier.flush()
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status = 'failed'").get().n).toBe(1)
    await ctx.tick.run()
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status = 'failed'").get().n).toBe(0)
    expect(ctx.emails.sent.filter((m) => m.to === 'pat@test.local')).toHaveLength(1)
    expect(ctx.emails.sent.filter((m) => m.to === 'doc@test.local')).toHaveLength(1)
  })
})
