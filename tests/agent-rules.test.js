import { describe, it, expect } from 'vitest'
import { makeApp, login, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { isQuietNow, nextQuietEnd, quietHold } from '../server/services/agent/quiet.js'
import { validateDecision, fixedRules, LIMITS } from '../server/services/agent/policy.js'
import { SYSTEM_PROMPT } from '../server/services/agent/prompt.js'
import { changeStatus } from '../server/services/appointments.js'

const MIN = 60000
const iso = (ms) => new Date(ms).toISOString()
const FRI_9 = '2026-10-23T03:30:00.000Z' // Fri 23 Oct 09:00 IST
const NIGHT = new Date('2026-10-22T17:30:00.000Z') // Thu 22 Oct 23:00 IST
const CFG = (over = {}) => ({ agent: { service: 'openai', model: 'gpt-5-mini', demoMinutes: null, quietHours: true, ...over } })
const say = (content) => () => ({ content, finishReason: 'completed' })
const decision = (over) => ({ action: 'wait', reason: 'Because.', wait_minutes: 0, slot_option_ids: [], email_note: '', ...over })
const log = (db, id) => db.prepare('SELECT * FROM agent_log WHERE appointment_id = ? ORDER BY id').all(id)
const mailsTo = (emails, to) => emails.sent.filter((m) => m.to === to)

// Two doctors in one department and a patient with a stuck appointment created `ageMin` minutes before "now".
async function world({ ageMin = 180, startUtc = FRI_9, status = 'pending', now, config, off } = {}) {
  const ctx = await makeApp({ now, config, off })
  const a = addDoctor(ctx.db, { email: 'doc@test.local', name: 'Dr One' })
  const b = addDoctor(ctx.db, { email: 'doc2@test.local', name: 'Dr Two' })
  const patientId = addPatient(ctx.db)
  const id = addAppointment(ctx.db, { doctorId: a.doctorId, patientId, startUtc, status, name: 'Asha Secret' })
  ctx.db.prepare("UPDATE appointments SET created_at = ?, reason = 'Fake: private chest pain' WHERE id = ?").run(iso(ctx.clock.now.getTime() - ageMin * MIN), id)
  if (status === 'needs_rebooking') ctx.db.prepare("INSERT INTO appointment_events (appointment_id, event, from_status, to_status, actor_role, created_at) VALUES (?, 'needs_rebooking', 'confirmed', 'needs_rebooking', 'doctor', ?)").run(id, iso(ctx.clock.now.getTime() - ageMin * MIN))
  const admin = await login(ctx.app, ADMIN.email, ADMIN.password)
  return { ...ctx, a, b, id, patientId, admin, advance: (min) => { ctx.clock.now = new Date(ctx.clock.now.getTime() + min * MIN) } }
}

describe('quiet hours (pure rules)', () => {
  const at = (ist) => iso(Date.parse(`2026-10-22T${ist}:00+05:30`))
  it('10 PM up to 8 AM IST is quiet; 8 AM and 9:59 PM are not', () => {
    expect(isQuietNow(at('21:59'))).toBe(false)
    expect(isQuietNow(at('22:00'))).toBe(true)
    expect(isQuietNow(at('23:59'))).toBe(true)
    expect(isQuietNow(at('00:00'))).toBe(true)
    expect(isQuietNow(at('07:59'))).toBe(true)
    expect(isQuietNow(at('08:00'))).toBe(false)
    expect(isQuietNow(at('12:00'))).toBe(false)
  })
  it('the hold ends at the next 8:00 AM IST: tomorrow after 10 PM, today after midnight', () => {
    expect(nextQuietEnd(at('23:00'))).toBe('2026-10-23T02:30:00.000Z') // 23 Oct 08:00 IST
    expect(nextQuietEnd(at('03:00'))).toBe('2026-10-22T02:30:00.000Z') // 22 Oct 08:00 IST
  })
  it('holds an email at night unless the appointment is less than 2 hours away, or quiet hours are switched off', () => {
    const start = (hoursAhead, from = at('23:00')) => iso(Date.parse(from) + hoursAhead * 3600000)
    const held = quietHold(at('23:00'), start(10))
    expect(held).toMatchObject({ hold: true, until: '2026-10-23T02:30:00.000Z', untilText: '8:00 AM IST tomorrow' })
    expect(held.why).toMatch(/11:00 PM IST/)
    expect(quietHold(at('03:00'), start(10, at('03:00')))).toMatchObject({ hold: true, untilText: '8:00 AM IST' })
    expect(quietHold(at('23:00'), start(1.99))).toMatchObject({ hold: false, exempt: true })
    expect(quietHold(at('23:00'), start(2))).toMatchObject({ hold: true }) // exactly 2 hours away is not "less than 2 hours"
    expect(quietHold(at('23:00'), iso(Date.parse(at('23:00')) - 3600000))).toMatchObject({ hold: false }) // already past
    expect(quietHold(at('12:00'), start(10, at('12:00')))).toEqual({ hold: false })
    expect(quietHold(at('23:00'), start(10), { enabled: false })).toEqual({ hold: false })
  })
})

describe('quiet hours in the agent', () => {
  it('holds a doctor reminder chosen at 11 PM until 8 AM, says why, and decides again at 8 AM (then sends it)', async () => {
    const w = await world({ now: NIGHT, config: CFG() })
    w.fake.ai = say(decision({ action: 'remind_doctor', reason: 'Unconfirmed for 3 hours.' }))
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ cases: 1, waits: 1, actions: 0 })
    expect(mailsTo(w.emails, 'doc@test.local')).toHaveLength(0)
    const [row] = log(w.db, w.id)
    expect(row).toMatchObject({ source: 'guard', action: 'hold_quiet_hours', executed: 1 })
    expect(row.reason).toMatch(/^Quiet hours: "remind the doctor" is held until 8:00 AM IST tomorrow\./)
    expect(row.reason).toMatch(/11:00 PM IST/)
    expect(row.reason).toMatch(/fresh facts/)
    expect(JSON.parse(row.params)).toMatchObject({ heldAction: 'remind_doctor', chosenBy: 'ai', resumeAtIst: '8:00 AM IST tomorrow' })
    expect(w.db.prepare('SELECT next_check_at FROM agent_cases WHERE appointment_id = ?').get(w.id).next_check_at).toBe('2026-10-23T02:30:00.000Z')
    // the held step is not counted as a reminder, and the page shows it
    const page = (await w.admin.get('/api/admin/agent').expect(200)).body
    expect(page.openCases[0].done.doctorReminders).toBe(0)
    expect(page.openCases[0].lastDecision).toMatchObject({ action: 'hold_quiet_hours' })
    expect(page.quietHours).toMatchObject({ enabled: true, activeNow: true })
    expect(page.quietHours.resumeAtIst).toMatch(/8:00 AM/)

    // pressing Check now at midnight does nothing more: the case is not due until 8 AM
    w.advance(60)
    expect((await w.tick.run()).agent).toMatchObject({ cases: 0, notDue: 1 })
    expect(w.fake.aiCalls).toHaveLength(1)

    // 8:00 AM IST: not quiet any more, the AI is asked again and the email goes
    w.clock.now = new Date('2026-10-23T02:31:00.000Z')
    await w.tick.run()
    expect(w.fake.aiCalls).toHaveLength(2)
    expect(mailsTo(w.emails, 'doc@test.local').filter((m) => /Reminder: appointment request/.test(m.subject))).toHaveLength(1)
    expect(log(w.db, w.id).at(-1)).toMatchObject({ action: 'remind_doctor', executed: 1, outcome: 'sent' })
  })

  it('does not hold an email when the appointment is less than 2 hours away', async () => {
    const w = await world({ now: NIGHT, config: CFG(), startUtc: '2026-10-22T18:30:00.000Z' }) // 00:00 IST, 1 hour away
    w.fake.ai = say(decision({ action: 'remind_doctor' }))
    await w.tick.run()
    expect(mailsTo(w.emails, 'doc@test.local')).toHaveLength(1)
    expect(log(w.db, w.id)[0]).toMatchObject({ action: 'remind_doctor', executed: 1 })
  })

  it('holds patient emails too (slot offers and reminders), including when the fixed rules decide because the AI is down', async () => {
    const w = await world({ now: NIGHT, config: CFG(), status: 'needs_rebooking', ageMin: 60 })
    w.fake.ai = say(decision({ action: 'offer_slots_to_patient', slot_option_ids: [1, 2], email_note: 'New times.' }))
    await w.tick.run()
    expect(mailsTo(w.emails, 'pat@test.local')).toHaveLength(0)
    expect(log(w.db, w.id)[0]).toMatchObject({ action: 'hold_quiet_hours', executed: 1 })
    expect(JSON.parse(log(w.db, w.id)[0].params).heldAction).toBe('offer_slots_to_patient')

    const down = await world({ now: NIGHT, config: CFG(), status: 'needs_rebooking', ageMin: 60 })
    down.fake.ai = null
    await down.tick.run()
    expect(mailsTo(down.emails, 'pat@test.local')).toHaveLength(0)
    expect(JSON.parse(log(down.db, down.id).at(-1).params)).toMatchObject({ heldAction: 'offer_slots_to_patient', chosenBy: 'fallback' })
  })

  it('Slack alerts to the admin still go at night, and nothing else is sent to patients or doctors', async () => {
    const w = await world({ now: NIGHT, config: CFG(), ageMin: 400 })
    w.fake.ai = say(decision({ action: 'alert_admin', reason: 'Over 6 hours.' }))
    await w.tick.run()
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
    expect(log(w.db, w.id)[0]).toMatchObject({ action: 'alert_admin', executed: 1, outcome: 'sent' })
    expect(w.emails.sent).toHaveLength(0)
  })

  it('a wait is still just a wait at night, and quiet hours can be switched off (AGENT_QUIET_HOURS=off)', async () => {
    const w = await world({ now: NIGHT, config: CFG(), ageMin: 90 })
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 30 }))
    await w.tick.run()
    expect(log(w.db, w.id)[0].action).toBe('wait')

    const off = await world({ now: NIGHT, config: CFG({ quietHours: false }), ageMin: 180 })
    off.fake.ai = say(decision({ action: 'remind_doctor' }))
    await off.tick.run()
    expect(mailsTo(off.emails, 'doc@test.local')).toHaveLength(1)
    expect((await off.admin.get('/api/admin/agent').expect(200)).body.quietHours).toMatchObject({ enabled: false, activeNow: false })
  })

  it('the page says quiet hours are not active in the daytime', async () => {
    const w = await world({ config: CFG() }) // 9:30 AM IST
    const q = (await w.admin.get('/api/admin/agent').expect(200)).body.quietHours
    expect(q).toEqual({ enabled: true, activeNow: false, resumeAtIst: null })
  })
})

describe('slot offers: once per case, again only if the free slots changed, at most 2', () => {
  const facts = (over = {}) => ({
    caseType: 'needs_rebooking', minutesSinceCaseStart: 300, minutesUntilAppointment: 2000,
    counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 0, offers: 1 },
    minutesSinceLast: { remind_doctor: null, remind_patient: null, offer_slots_to_patient: 200 },
    options: [{ id: 1 }, { id: 2 }, { id: 3 }], optionsKey: 'a|b|c', lastOfferKey: 'a|b|c', ...over
  })
  const offer = { action: 'offer_slots_to_patient', slotOptionIds: [1, 2] }

  it('the limit is 2 offers per case', () => {
    expect(LIMITS.maxOffers).toBe(2)
    expect(validateDecision(offer, facts({ lastOfferKey: 'x', counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 0, offers: 2 } })).why).toMatch(/already offered slots 2 times/)
  })
  it('refuses the same free slots again; allows it when they changed, or when there is no record of the last list', () => {
    expect(validateDecision(offer, facts()).why).toBe('the free slots have not changed since the last offer')
    expect(validateDecision(offer, facts({ optionsKey: 'a|b|d' })).ok).toBe(true)
    expect(validateDecision(offer, facts({ lastOfferKey: null })).ok).toBe(true)
    expect(validateDecision(offer, facts({ counts: { doctorReminders: 0, patientReminders: 0, adminAlerts: 0, offers: 0 }, lastOfferKey: null })).ok).toBe(true)
  })
  it('the fixed rules do not repeat an offer for unchanged slots, and say so when they offer again', () => {
    expect(fixedRules(facts()).action).not.toBe('offer_slots_to_patient')
    const again = fixedRules(facts({ optionsKey: 'a|b|d' }))
    expect(again).toMatchObject({ action: 'offer_slots_to_patient' })
    expect(again.reason).toMatch(/free slots have changed/)
  })
  it('the AI is told the limit, and whether the free slots changed', () => {
    expect(SYSTEM_PROMPT).toMatch(/2 slot offers per case \(a second one only if the free slots changed\)/)
    expect(SYSTEM_PROMPT).toMatch(/free_slots_changed_since_last_offer is true/)
  })

  it('end to end: one offer; no second email while the slots are the same; a second only after they change; never a third', async () => {
    // 3 PM IST: today's slots are over, so the free slots stay the same as time moves on (until someone books one)
    const w = await world({ status: 'needs_rebooking', ageMin: 60, now: new Date('2026-10-22T09:30:00.000Z') })
    const offers = () => mailsTo(w.emails, 'pat@test.local').filter((m) => m.subject === 'Other times are available for your appointment')
    const ask = () => JSON.parse(w.fake.aiCalls.at(-1).message)
    w.fake.ai = say(decision({ action: 'offer_slots_to_patient', slot_option_ids: [1, 2, 3], email_note: 'We found other times.' }))
    await w.tick.run()
    expect(offers()).toHaveLength(1)
    expect(log(w.db, w.id)[0].params).toMatch(/optionsKey/)

    w.advance(130) // past the 2-hour gap; the free slots are exactly the same
    await w.tick.run()
    expect(ask().free_slots_changed_since_last_offer).toBe(false)
    expect(offers()).toHaveLength(1)
    const refused = log(w.db, w.id).find((x) => x.executed === 0)
    expect(refused).toMatchObject({ source: 'ai', action: 'offer_slots_to_patient' })
    expect(refused.outcome).toMatch(/Refused by the rules: the free slots have not changed since the last offer/)

    // someone books one of the free slots: the list changes, a second offer is allowed
    const [slot] = (await import('../server/services/scheduling.js')).rebookOptions(w.db, w.db.prepare('SELECT * FROM appointments WHERE id = ?').get(w.id), w.clock.now.toISOString(), { limit: 8, perDoctor: 4, leadMinutes: 60 })
    addAppointment(w.db, { doctorId: slot.doctorId, patientId: addPatient(w.db, 'rival@test.local', 'Rival'), startUtc: slot.startUtc })
    w.advance(130)
    await w.tick.run()
    expect(ask().free_slots_changed_since_last_offer).toBe(true)
    expect(offers()).toHaveLength(2)

    // changed again, but that would be a third offer
    const [slot2] = (await import('../server/services/scheduling.js')).rebookOptions(w.db, w.db.prepare('SELECT * FROM appointments WHERE id = ?').get(w.id), w.clock.now.toISOString(), { limit: 8, perDoctor: 4, leadMinutes: 60 })
    addAppointment(w.db, { doctorId: slot2.doctorId, patientId: addPatient(w.db, 'rival2@test.local', 'Rival Two'), startUtc: slot2.startUtc })
    w.advance(130)
    await w.tick.run()
    expect(offers()).toHaveLength(2)
    expect(log(w.db, w.id).some((x) => x.executed === 0 && /already offered slots 2 times/.test(x.outcome))).toBe(true)

    const page = (await w.admin.get('/api/admin/agent').expect(200)).body
    expect(page.maxOffers).toBe(2)
    expect(page.openCases[0].done.offers).toBe(2)
  })
})

describe('an unconfirmed request whose appointment time has passed expires', () => {
  const FLOW = (slot) => FLOW_URL(slot)
  // the appointment starts 1 hour after "now" (9:30 AM IST); then time moves 2 hours on
  async function expired(opts = {}) {
    const w = await world({ ageMin: 300, startUtc: '2026-10-22T05:00:00.000Z', config: CFG(), ...opts })
    w.fake.ai = say(decision({ action: 'wait', wait_minutes: 30 }))
    return w
  }

  it('marks it expired, emails the patient, adds a sheet row, alerts the admin, closes the case and logs why', async () => {
    const w = await expired()
    w.advance(120)
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ expired: 1, decisions: 1 })
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(w.id).status).toBe('expired')
    expect(w.db.prepare("SELECT event, from_status, to_status, actor_role FROM appointment_events WHERE appointment_id = ? AND event = 'expired'").get(w.id)).toEqual({ event: 'expired', from_status: 'pending', to_status: 'expired', actor_role: 'system' })

    const mail = mailsTo(w.emails, 'pat@test.local')
    expect(mail).toHaveLength(1)
    expect(mail[0].subject).toBe('Your appointment request expired: please book again')
    expect(mail[0].body).toContain('please book again'.replace('please book again', 'book again'))
    expect(mail[0].body).toContain(`${w.config.appUrl}/doctors`)
    expect(w.fake.postsTo('appointments_sheet').some((p) => p.event === 'expired' && p.status === 'expired' && p.appointment_id === w.id)).toBe(true)
    const slack = w.fake.postsTo('slack_alert')
    expect(slack).toHaveLength(1)
    expect(slack[0].text).toMatch(/appointment #1 .* expired/)
    expect(slack[0].text).not.toMatch(/Asha|chest pain|90000|pat@/i) // no patient details in Slack
    expect(mailsTo(w.emails, 'doc@test.local').filter((m) => !/^Your appointments for today/.test(m.subject))).toHaveLength(0) // the doctor is not told about the expiry (their morning schedule email is a different thing)

    expect(w.db.prepare('SELECT closed_reason, closed_at FROM agent_cases WHERE appointment_id = ?').get(w.id)).toMatchObject({ closed_reason: 'expired' })
    const rows = log(w.db, w.id)
    expect(rows).toHaveLength(1) // no second "case resolved" line
    expect(rows[0]).toMatchObject({ source: 'guard', action: 'expire_request', executed: 1 })
    expect(rows[0].reason).toMatch(/passed and the doctor never confirmed the request, so it was marked expired/)
    expect(rows[0].outcome).toBe('patient email sent; sheet row sent; admin alert sent')
    expect(w.fake.aiCalls).toHaveLength(0) // no AI needed for this
  })

  it('happens once: ticking again sends nothing more', async () => {
    const w = await expired()
    w.advance(120)
    await w.tick.run()
    await w.tick.run()
    await Promise.all([w.tick.run(), w.tick.run()])
    expect(mailsTo(w.emails, 'pat@test.local')).toHaveLength(1)
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
    expect(w.fake.postsTo('appointments_sheet').filter((p) => p.event === 'expired')).toHaveLength(1)
    expect(log(w.db, w.id)).toHaveLength(1)
  })

  it('a request that has not passed yet, a confirmed one, and a cancelled one are left alone', async () => {
    const w = await expired()
    await w.tick.run() // 9:30 AM, appointment at 10:30 AM
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(w.id).status).toBe('pending')
    const confirmed = addAppointment(w.db, { doctorId: w.a.doctorId, patientId: w.patientId, startUtc: '2026-10-22T04:30:00.000Z', status: 'confirmed' })
    const cancelled = addAppointment(w.db, { doctorId: w.a.doctorId, patientId: w.patientId, startUtc: '2026-10-22T04:45:00.000Z', status: 'cancelled_by_patient' })
    w.advance(120)
    await w.tick.run()
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(confirmed).status).toBe('confirmed')
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(cancelled).status).toBe('cancelled_by_patient')
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(w.id).status).toBe('expired')
  })

  it('works even if the agent never looked at the request, and sends the email even at night (the appointment time is past)', async () => {
    const w = await world({ ageMin: 20, startUtc: '2026-10-22T17:00:00.000Z', now: new Date('2026-10-22T17:30:00.000Z'), config: CFG() }) // 23:00 IST, started 30 min ago
    expect(w.db.prepare('SELECT COUNT(*) n FROM agent_cases').get().n).toBe(0)
    await w.tick.run()
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(w.id).status).toBe('expired')
    expect(mailsTo(w.emails, 'pat@test.local')).toHaveLength(1)
    expect(w.fake.postsTo('slack_alert')).toHaveLength(1)
  })

  it('still expires when email, sheet and Slack are not set up: the status changes and the log says what was skipped', async () => {
    const w = await expired({ off: ['email_sender', 'appointments_sheet', 'slack_alert'] })
    w.advance(120)
    await w.tick.run()
    expect(w.db.prepare('SELECT status FROM appointments WHERE id = ?').get(w.id).status).toBe('expired')
    expect(log(w.db, w.id)[0].outcome).toBe('patient email skipped; sheet row skipped; admin alert skipped')
  })

  it('a failed expiry email is tried again on a later tick and still sent only once', async () => {
    const w = await expired()
    w.fake.replyFor = (url) => (url === FLOW('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    w.advance(120)
    await w.tick.run()
    expect(mailsTo(w.emails, 'pat@test.local')).toHaveLength(0)
    expect(log(w.db, w.id)[0].outcome).toMatch(/patient email failed \(retried later\); sheet row sent; admin alert sent/)
    w.fake.replyFor = null
    await w.tick.run()
    await w.tick.run()
    expect(mailsTo(w.emails, 'pat@test.local')).toHaveLength(1)
  })

  it('an expired request is final: the doctor cannot confirm it, the patient sees it in the past list with a way to book again', async () => {
    const w = await expired()
    w.advance(120)
    await w.tick.run()
    expect(() => changeStatus(w.db, w.id, 'confirmed', { actorRole: 'doctor' })).toThrow(/cannot become confirmed/)
    const doctor = await login(w.app, 'doc@test.local', 'password-123')
    await doctor.post(`/api/doctor/appointments/${w.id}/confirm`).expect(409)
    const patient = await login(w.app, 'pat@test.local', 'password-123')
    const mine = (await patient.get('/api/patient/appointments').expect(200)).body
    expect(mine.upcoming).toHaveLength(0)
    expect(mine.past.map((a) => [a.id, a.status])).toEqual([[w.id, 'expired']])
    await patient.post(`/api/patient/appointments/${w.id}/cancel`).send({}).expect(409) // nothing left to cancel
    const list = (await w.admin.get('/api/admin/appointments?status=expired').expect(200)).body
    expect(JSON.stringify(list)).toMatch(/expired/)
  })

  it('the decision is on the Agent activity page with its reason and what was sent', async () => {
    const w = await expired()
    w.advance(120)
    await w.tick.run()
    const page = (await w.admin.get('/api/admin/agent').expect(200)).body
    expect(page.openCases).toHaveLength(0)
    expect(page.decisions[0]).toMatchObject({ action: 'expire_request', source: 'guard', executed: true, appointmentId: w.id })
    expect(page.decisions[0].reason).toMatch(/marked expired/)
    expect(page.decisions[0].outcome).toMatch(/patient email sent/)
    expect(page.decisions[0].params).toEqual({ patientEmail: 'sent', sheetRow: 'sent', adminAlert: 'sent' })
  })
})
