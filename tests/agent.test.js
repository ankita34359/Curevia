import { describe, it, expect } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { fixedRules, validateDecision, limitsFor, nextStep, LIMITS } from '../server/services/agent/policy.js'
import { loadConfig, parseDemoMinutes, isDocumentedModel } from '../server/config.js'
import { rebookOptions } from '../server/services/scheduling.js'

const FRI_9 = '2026-10-23T03:30:00.000Z' // Fri 23 Oct 09:00 IST
const MIN = 60000
const iso = (ms) => new Date(ms).toISOString()

// One department with two doctors, a patient with a pending appointment created `ageMin` minutes before "now".
async function world({ ageMin = 180, startUtc = FRI_9, status = 'pending', noEmail = false, off, config } = {}) {
  const ctx = await makeApp({ noEmail, off, config })
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

  it('does not ask the AI about a request younger than 30 minutes, but writes down that it is waiting, why, and until when', async () => {
    const w = await world({ ageMin: 3 })
    w.fake.ai = say(decision({ action: 'remind_doctor' }))
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ cases: 1, decisions: 1, waits: 1, actions: 0, notDue: 0 })
    expect(w.fake.aiCalls).toHaveLength(0)
    const [row] = log(w.db, w.id)
    expect(row).toMatchObject({ source: 'guard', action: 'wait', executed: 1 })
    // created 9:27 AM IST -> the doctor is reminded at the 2 hour mark, 11:27 AM IST
    expect(row.reason).toMatch(/^Waiting: remind the doctor at 11:27 AM IST\./)
    expect(row.reason).toMatch(/only 3 minutes old/)
    expect(row.reason).toMatch(/AI was not asked/)
    expect(JSON.parse(row.params)).toMatchObject({ nextStep: { action: 'remind_doctor', atIst: '11:27 AM IST' }, nextCheckAtIst: '9:57 AM IST' })
    // the case is checked again when it turns 30 minutes old
    expect(w.db.prepare('SELECT next_check_at FROM agent_cases WHERE appointment_id = ?').get(w.id).next_check_at).toBe(iso(w.clock.now.getTime() + 27 * MIN))

    // the admin page shows it: "Last decision" and "Next check" are filled in
    const page = (await w.admin.get('/api/admin/agent').expect(200)).body
    expect(page.openCases[0].lastDecision).toMatchObject({ action: 'wait', source: 'guard' })
    expect(page.openCases[0].lastDecision.reason).toMatch(/^Waiting: remind the doctor at 11:27 AM IST/)
    expect(page.openCases[0].nextCheckIst).toMatch(/9:57 AM/)
    expect(page.decisions[0]).toMatchObject({ action: 'wait', executed: true })

    // pressing "Check now" again right away does not pile up rows; it says the case is not due yet
    const again = await w.tick.run()
    expect(again.agent).toMatchObject({ cases: 0, notDue: 1, decisions: 0 })
    expect(log(w.db, w.id)).toHaveLength(1)

    // at 30 minutes old the AI is asked
    w.advance(28)
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 45, reason: 'Too early to nudge.' }))
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(1)
    expect(log(w.db, w.id).at(-1)).toMatchObject({ source: 'ai', action: 'wait' })
  })

  it('a wait chosen by the AI is logged with its reason, the next step and the next check (the earlier of the wait and the next step)', async () => {
    const w = await world({ ageMin: 60 }) // reminder due in 60 minutes (10:30 AM IST)
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 45, reason: 'Too early to nudge.' }))
    await w.tick.run()
    let row = log(w.db, w.id).at(-1)
    expect(row).toMatchObject({ source: 'ai', action: 'wait', executed: 1 })
    expect(row.reason).toMatch(/^Waiting: remind the doctor at 10:30 AM IST\. Too early to nudge\.$/)
    expect(row.outcome).toBe('waiting; next check 10:15 AM IST')
    expect(w.db.prepare('SELECT next_check_at FROM agent_cases WHERE appointment_id = ?').get(w.id).next_check_at).toBe(iso(w.clock.now.getTime() + 45 * MIN))

    // a long wait is cut short so the reminder is not missed
    const w2 = await world({ ageMin: 60 })
    w2.fake.ai = say(decision({ action: 'wait', wait_minutes: 300, reason: 'Later.' }))
    await w2.tick.run()
    expect(w2.db.prepare('SELECT next_check_at FROM agent_cases WHERE appointment_id = ?').get(w2.id).next_check_at).toBe(iso(w2.clock.now.getTime() + 60 * MIN))
    row = log(w2.db, w2.id).at(-1)
    expect(row.outcome).toBe('waiting; next check 10:30 AM IST')
  })

  it('when the AI is down and nothing is due, the fixed-rule wait is logged too, with the reason the AI was not used', async () => {
    const w = await world({ ageMin: 40 })
    w.fake.ai = null
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ waits: 1, fallbacks: 1 })
    const row = log(w.db, w.id)[0]
    expect(row).toMatchObject({ source: 'fallback', action: 'wait', executed: 1 })
    expect(row.reason).toMatch(/^Waiting: remind the doctor at 10:50 AM IST\. Fixed rule: nothing is due yet/)
    expect(row.ai_error).toBeTruthy()
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


describe('next step and demo timing', () => {
  const facts = (over = {}) => ({
    caseType: 'pending', minutesSinceCaseStart: 10, minutesUntilAppointment: 2000,
    counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 0, offers: 0 },
    minutesSinceLast: { remind_doctor: null, remind_patient: null, offer_slots_to_patient: null },
    options: [], ...over
  })
  const DEMO_ENV = { SESSION_SECRET: 'test-session-secret-123456', ADMIN_EMAIL: 'a@b.test', ADMIN_PASSWORD: 'password-123' }

  it('nextStep: the earliest of reminder, second reminder, admin alert and offer', () => {
    expect(nextStep(facts())).toMatchObject({ action: 'remind_doctor', inMin: 110 })
    expect(nextStep(facts({ minutesSinceCaseStart: 130, counts: { doctorReminders: 1, patientReminders: 0, adminAlerts: 0, offers: 0 }, minutesSinceLast: { remind_doctor: 10, remind_patient: null, offer_slots_to_patient: null } }))).toMatchObject({ action: 'remind_doctor_again', inMin: 110 })
    expect(nextStep(facts({ minutesSinceCaseStart: 250, counts: { doctorReminders: 2, patientReminders: 0, adminAlerts: 0, offers: 0 } }))).toMatchObject({ action: 'alert_admin', inMin: 110 })
    expect(nextStep(facts({ minutesSinceCaseStart: 400, counts: { doctorReminders: 2, patientReminders: 0, adminAlerts: 1, offers: 1 } }))).toBeNull()
    expect(nextStep(facts({ caseType: 'needs_rebooking', minutesSinceCaseStart: 5 }))).toMatchObject({ action: 'offer_slots_to_patient', inMin: 0 })
  })

  it('AGENT_DEMO_MINUTES: off unless it is a number from 1 to 120', () => {
    for (const bad of [undefined, '', '  ', 'abc', '0', '-3', '121', 'NaN']) expect(parseDemoMinutes(bad)).toBeNull()
    expect(parseDemoMinutes('2')).toBe(2)
    expect(parseDemoMinutes(' 5 ')).toBe(5)
    expect(loadConfig(DEMO_ENV).agent).toMatchObject({ demoMinutes: null, demoMinutesIgnored: false })
    expect(loadConfig({ ...DEMO_ENV, AGENT_DEMO_MINUTES: '2' }).agent).toMatchObject({ demoMinutes: 2, demoMinutesIgnored: false })
    expect(loadConfig({ ...DEMO_ENV, AGENT_DEMO_MINUTES: 'two' }).agent).toMatchObject({ demoMinutes: null, demoMinutesIgnored: true })
  })

  it('limitsFor: the same object when off; with 2, hours become minutes (2 -> 2 min, 6 -> 6 min, 4 -> 4 min)', () => {
    expect(limitsFor(null)).toBe(LIMITS)
    expect(limitsFor(undefined)).toBe(LIMITS)
    expect(limitsFor('junk')).toBe(LIMITS)
    const d = limitsFor(2)
    expect(d).toMatchObject({ demo: true, remindDoctorAfterMin: 2, alertAdminAfterMin: 6, minCaseAgeMin: 0.5, offerWhenWithinMin: 12 * 60 })
    expect(d.minGapMinutes).toEqual({ remind_doctor: 1, remind_patient: 1, offer_slots_to_patient: 2 })
    expect(limitsFor(4)).toMatchObject({ remindDoctorAfterMin: 4, alertAdminAfterMin: 12 })
    expect(LIMITS.remindDoctorAfterMin).toBe(120) // the real limits are never modified
  })

  it('in demo timing the rules follow the short times', () => {
    const d = limitsFor(2)
    expect(fixedRules(facts({ minutesSinceCaseStart: 1.5 }), d).action).toBe('wait')
    expect(fixedRules(facts({ minutesSinceCaseStart: 2.5 }), d)).toMatchObject({ action: 'remind_doctor' })
    expect(fixedRules(facts({ minutesSinceCaseStart: 2.5 }), d).reason).toMatch(/after 2 minutes/)
    expect(fixedRules(facts({ minutesSinceCaseStart: 6.5 }), d).action).toBe('alert_admin')
    expect(fixedRules(facts({ minutesSinceCaseStart: 2.5 })).action).toBe('wait') // normal timing: still 2 minutes in
    expect(validateDecision({ action: 'wait', waitMinutes: 99999 }, facts(), d).decision.waitMinutes).toBe(12)
    expect(validateDecision({ action: 'wait', waitMinutes: 0 }, facts(), d).decision.waitMinutes).toBe(1)
    expect(validateDecision({ action: 'remind_doctor' }, facts({ minutesSinceLast: { remind_doctor: 0.5, remind_patient: null, offer_slots_to_patient: null } }), d).why).toMatch(/less than 1 minute ago/)
    expect(validateDecision({ action: 'remind_doctor' }, facts({ minutesSinceLast: { remind_doctor: 1.5, remind_patient: null, offer_slots_to_patient: null } }), d).ok).toBe(true)
  })

  it('the whole flow runs in minutes: wait, remind the doctor, remind again, alert the admin (once)', async () => {
    const w = await world({ ageMin: 0.25, config: { agent: { service: 'openai', model: 'gpt-5-mini', demoMinutes: 2 } } })
    w.fake.ai = null // the fixed rules decide, so the steps are predictable
    const rows = () => log(w.db, w.id)
    const doctorMails = () => mailsTo(w.emails, 'doc@test.local').filter((m) => /Reminder: appointment request/.test(m.subject))

    await w.tick.run() // 15 seconds old: too new
    expect(rows()[0]).toMatchObject({ source: 'guard', action: 'wait' })
    expect(rows()[0].reason).toMatch(/only 18 seconds old/)
    expect(rows()[0].reason).toMatch(/^Waiting: remind the doctor at 9:32 AM IST/) // 9:30 now + 2 min - 18 s = 9:31:42, shown rounded up

    w.advance(1) // 1.25 min: nothing due yet, the wait is logged
    await w.tick.run()
    expect(rows().at(-1)).toMatchObject({ source: 'fallback', action: 'wait' })
    expect(doctorMails()).toHaveLength(0)

    w.advance(1) // 2.25 min: the doctor is reminded
    await w.tick.run()
    expect(rows().at(-1)).toMatchObject({ action: 'remind_doctor', executed: 1, outcome: 'sent' })
    expect(doctorMails()).toHaveLength(1)

    w.advance(2) // 4.25 min: the second reminder
    await w.tick.run()
    expect(doctorMails()).toHaveLength(2)

    w.advance(2.5) // 6.75 min: the admin is alerted, once
    await w.tick.run()
    expect(rows().at(-1)).toMatchObject({ action: 'alert_admin', executed: 1 })
    const alerts = w.fake.postsTo('slack_alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].text).toMatch(/not confirmed it after 7 min\./)
    expect(alerts[0].text).not.toMatch(/after 0 h/)
    w.advance(2)
    await w.tick.run()
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
    expect(doctorMails()).toHaveLength(2) // never more than 2 reminders, demo or not
  })

  it('the AI is told the demo timings; in normal timing it is told hours', async () => {
    const demo = await world({ ageMin: 3, config: { agent: { service: 'openai', model: 'gpt-5-mini', demoMinutes: 2 } } })
    demo.fake.ai = say(decision({ action: 'wait', wait_minutes: 1 }))
    await demo.tick.run()
    expect(demo.fake.aiCalls[0].prompt).toMatch(/unconfirmed for 2 minutes/)
    expect(demo.fake.aiCalls[0].prompt).toMatch(/open for 6 minutes/)
    expect(demo.fake.aiCalls[0].prompt).toMatch(/live demo/)
    const real = await world({ ageMin: 130 })
    real.fake.ai = say(decision({ action: 'wait', wait_minutes: 30 }))
    await real.tick.run()
    expect(real.fake.aiCalls[0].prompt).toMatch(/unconfirmed for 2 hours/)
    expect(real.fake.aiCalls[0].prompt).not.toMatch(/live demo/)
  })

  it('the Agent activity API says whether demo timing is on (the page shows a badge)', async () => {
    const off = await world()
    expect((await off.admin.get('/api/admin/agent').expect(200)).body.demoMinutes).toBeNull()
    const on = await world({ config: { agent: { service: 'openai', model: 'gpt-5-mini', demoMinutes: 2 } } })
    expect((await on.admin.get('/api/admin/agent').expect(200)).body.demoMinutes).toBe(2)
  })

  it('the default model is on the viaSocket AI API documented list', () => {
    const { service, model } = loadConfig(DEMO_ENV).agent
    expect(isDocumentedModel(service, model)).toBe(true)
    expect(isDocumentedModel('openai', 'gpt-5-mini')).toBe(true)
    expect(isDocumentedModel('anthropic', 'claude-sonnet-4-6')).toBe(true)
    expect(isDocumentedModel('gemini', 'gemini-2.5-flash')).toBe(true)
    expect(isDocumentedModel('openai', 'gpt-9')).toBe(false)
    expect(isDocumentedModel('anthropic', 'gpt-5-mini')).toBe(false) // a model must match its service
    expect(isDocumentedModel('mistral', 'large')).toBe(false)
  })
})
