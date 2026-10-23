import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { buildServices } from '../server/services/index.js'
import { APPT_STATUSES } from '../server/routes/admin.js'

const MIN = 60000
const ist = (hhmm, day = '2026-10-22') => new Date(`${day}T${hhmm}:00+05:30`) // an India-time moment
const at = (hhmm, day = '2026-10-22') => new Date(`${day}T${hhmm}:00+05:30`).toISOString()
const DAILY = /^Your appointments for today/
const daily = (emails, to = 'doc@test.local') => emails.sent.filter((m) => m.to === to && DAILY.test(m.subject))
const dailyKeys = (db) => db.prepare("SELECT dedupe_key, status, attempts FROM deliveries WHERE type = 'doctor_daily_schedule' ORDER BY id").all()

// One doctor ("Dr One") and a patient; appointments are added by the tests.
async function world({ now = ist('09:30'), off, extraDoctor = false } = {}) {
  const w = await makeApp({ now, off })
  const doc = addDoctor(w.db, { email: 'doc@test.local', name: 'Dr One' })
  const doc2 = extraDoctor ? addDoctor(w.db, { email: 'doc2@test.local', name: 'Dr Two', dept: 'Cardiology' }) : null
  const patientId = addPatient(w.db)
  const appt = (doctor, startUtc, status = 'pending', fields = {}) => {
    const id = addAppointment(w.db, { doctorId: doctor.doctorId, patientId, startUtc, status })
    if (Object.keys(fields).length) w.db.prepare('UPDATE appointments SET patient_name = COALESCE(?, patient_name), age = COALESCE(?, age), gender = COALESCE(?, gender), reason = COALESCE(?, reason) WHERE id = ?').run(fields.name ?? null, fields.age ?? null, fields.gender ?? null, fields.reason ?? null, id)
    return id
  }
  const admin = await login(w.app, ADMIN.email, ADMIN.password)
  return { ...w, doc, doc2, patientId, appt, admin, set: (d) => { w.clock.now = d } }
}

describe('the morning email', () => {
  it('lists the day\'s pending and confirmed appointments, sorted by time, with a pending count and a dashboard button', async () => {
    const w = await world()
    w.appt(w.doc, at('11:30'), 'confirmed', { name: 'Ravi Kumar', age: 52, gender: 'male', reason: 'Knee pain' })
    w.appt(w.doc, at('10:00'), 'pending', { name: 'Asha Rao', age: 34, gender: 'female', reason: 'Fever and cough' })
    w.appt(w.doc, at('14:15'), 'pending', { name: 'Meena Iyer', age: 29, gender: 'female', reason: 'Headache' })
    w.appt(w.doc, at('08:30'), 'confirmed', { name: 'Early Bird', age: 61, gender: 'male', reason: 'Check-up' })
    w.appt(w.doc, at('16:00', '2026-10-23'), 'pending', { name: 'Tomorrow Person' }) // another day: not listed, but still a pending request
    const r = await w.tick.run()
    expect(r.daily).toMatchObject({ date: '2026-10-22', sent: 1, noAppointments: 0 })

    const mails = daily(w.emails)
    expect(mails).toHaveLength(1)
    expect(mails[0].subject).toBe('Your appointments for today (22 Oct 2026)')
    const body = mails[0].body
    const order = ['Early Bird', 'Asha Rao', 'Ravi Kumar', 'Meena Iyer'].map((n) => body.indexOf(n))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order) // 8:30, 10:00, 11:30, 2:15 PM
    for (const t of ['8:30 AM', '10:00 AM', '11:30 AM', '2:15 PM']) expect(body).toContain(t)
    for (const f of ['>52<', '>34<', '>Male<', '>Female<', 'Knee pain', 'Fever and cough', '>Pending<', '>Confirmed<']) expect(body).toContain(f)
    expect(body).not.toContain('Tomorrow Person')
    expect(body).toContain('You have <strong>4 appointments</strong> today, 22 Oct 2026')
    expect(body).toContain('<strong>3 requests still pending</strong> and waiting for your confirmation (2 of them today)')
    expect(body).toContain(`href="${w.config.appUrl}/doctor"`)
    expect(body).toContain('Open my dashboard')
  })

  it('uses the singular for one appointment and says when nothing is pending', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'confirmed', { name: 'Only One' })
    await w.tick.run()
    const body = daily(w.emails)[0].body
    expect(body).toContain('You have <strong>1 appointment</strong> today')
    expect(body).toContain('No requests are waiting for your confirmation.')
    const w2 = await world()
    w2.appt(w2.doc, at('10:00'), 'pending')
    await w2.tick.run()
    expect(daily(w2.emails)[0].body).toContain('<strong>1 request still pending</strong> and waiting for your confirmation (1 of them today)')
  })

  it('escapes what patients typed and shortens a very long reason', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'pending', { name: '<img src=x onerror=alert(1)>', reason: `<script>alert(1)</script>${'long reason '.repeat(40)}` })
    await w.tick.run()
    const body = daily(w.emails)[0].body
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body.match(/long reason/g).length).toBeLessThan(20) // clipped to 200 characters, not 480
    expect(body).toMatch(/…</)
  })

  it('only the doctor gets it: no patient email, no sheet row, no Slack message, and the AI agent is not involved', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'pending')
    await w.tick.run()
    expect(w.emails.sent.filter((m) => m.to !== 'doc@test.local')).toHaveLength(0)
    expect(w.fake.postsTo('appointments_sheet')).toHaveLength(0)
    expect(w.fake.postsTo('slack_alert')).toHaveLength(0)
    expect(w.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE channel IN ('sheet','slack')").get().n).toBe(0)
    expect(w.db.prepare("SELECT channel FROM deliveries WHERE type = 'doctor_daily_schedule'").all()).toEqual([{ channel: 'email' }])
  })
})

describe('when it is sent', () => {
  it('the first tick at or after 8:00 AM IST sends it; nothing before', async () => {
    const w = await world({ now: ist('07:59') })
    w.appt(w.doc, at('10:00'), 'pending')
    expect((await w.tick.run()).daily).toMatchObject({ due: false, sent: 0 })
    w.set(new Date(ist('07:59').getTime() + 59 * 1000)) // 07:59:59
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(0)
    w.set(ist('08:00'))
    expect((await w.tick.run()).daily).toMatchObject({ due: true, sent: 1 })
    expect(daily(w.emails)).toHaveLength(1)
  })

  it('a unique key per doctor per day makes it once only: repeated and simultaneous ticks, later ticks, and a restart send nothing more', async () => {
    const w = await world({ extraDoctor: true })
    w.appt(w.doc, at('19:00'), 'pending') // evening appointments: still pending and listed whenever the ticks below run
    w.appt(w.doc2, at('20:00'), 'confirmed')
    await Promise.all([w.tick.run(), w.tick.run(), w.tick.run()])
    for (let i = 1; i <= 6; i++) { w.set(new Date(w.clock.now.getTime() + 5 * MIN)); await w.tick.run() } // the next 6 ticks of the morning
    w.set(ist('18:00'))
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(1)
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(1)
    expect(dailyKeys(w.db).map((k) => k.dedupe_key)).toEqual([`email:doctor_daily_schedule:${w.doc.doctorId}:2026-10-22`, `email:doctor_daily_schedule:${w.doc2.doctorId}:2026-10-22`])

    // a restart: a brand-new set of services over the same database
    const restarted = buildServices({ config: w.config, db: w.db, clock: () => w.clock.now, client: w.fake.client, fetchImpl: w.fake.fetch })
    const r = await restarted.tick.run()
    expect(r.daily).toMatchObject({ sent: 0, alreadySent: 2 })
    expect(daily(w.emails)).toHaveLength(1)
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(1)
  })

  it('the next day it is sent again, with that day\'s date', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'pending')
    w.appt(w.doc, at('10:00', '2026-10-23'), 'confirmed')
    await w.tick.run()
    w.set(ist('08:05', '2026-10-23'))
    await w.tick.run()
    const mails = daily(w.emails)
    expect(mails.map((m) => m.subject)).toEqual(['Your appointments for today (22 Oct 2026)', 'Your appointments for today (23 Oct 2026)'])
    expect(dailyKeys(w.db)).toHaveLength(2)
  })

  it('uses the existing 5-minute schedule: embarko.json still has just the one tick job', () => {
    const cfg = JSON.parse(fs.readFileSync(new URL('../embarko.json', import.meta.url), 'utf8'))
    expect(cfg.schedules).toHaveLength(1)
    expect(cfg.schedules[0]).toMatchObject({ cron: '*/5 * * * *', path: '/api/cron/tick' })
  })

  it('the cron route still answers at once (the daily email is part of the background tick)', async () => {
    const w = await makeApp({ config: { cronSecret: 'cron-secret-for-tests' } })
    const res = await agentFor(w.app).get('/api/cron/tick').set('Authorization', 'Bearer cron-secret-for-tests')
    expect(res.status).toBe(202)
  })
})

describe('who gets it', () => {
  it('doctors with no pending or confirmed appointment today get nothing', async () => {
    const w = await world({ extraDoctor: true })
    w.appt(w.doc, at('10:00'), 'pending')
    // Dr Two: only other statuses today, and a booking on another day
    for (const [h, status] of [['09:00', 'completed'], ['09:30', 'no_show'], ['10:00', 'cancelled_by_patient'], ['10:30', 'cancelled_by_doctor'], ['11:00', 'needs_rebooking'], ['11:30', 'rebooked'], ['12:00', 'expired']]) w.appt(w.doc2, at(h), status)
    w.appt(w.doc2, at('10:00', '2026-10-23'), 'confirmed')
    const r = await w.tick.run()
    expect(r.daily).toMatchObject({ sent: 1, noAppointments: 1 })
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(0)
    expect(w.emails.sent.filter((m) => DAILY.test(m.subject))).toHaveLength(1)
  })

  it('a day with nobody booked sends no email at all', async () => {
    const w = await world({ extraDoctor: true })
    const r = await w.tick.run()
    expect(r.daily).toMatchObject({ sent: 0, noAppointments: 2 })
    expect(w.emails.sent).toHaveLength(0)
    expect(dailyKeys(w.db)).toEqual([])
  })

  it('a deactivated doctor is not emailed, and an appointment from another doctor is not mixed in', async () => {
    const w = await world({ extraDoctor: true })
    w.appt(w.doc, at('10:00'), 'pending', { name: 'For Dr One' })
    w.appt(w.doc2, at('11:00'), 'confirmed', { name: 'For Dr Two' })
    w.db.prepare('UPDATE doctors SET active = 0 WHERE id = ?').run(w.doc2.doctorId)
    w.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(w.doc2.userId)
    await w.tick.run()
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(0)
    expect(daily(w.emails)[0].body).toContain('For Dr One')
    expect(daily(w.emails)[0].body).not.toContain('For Dr Two')
  })

  it('a doctor whose first appointment appears later in the day is emailed at the next tick (once)', async () => {
    const w = await world()
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(0)
    w.appt(w.doc, at('16:00'), 'pending')
    w.set(ist('12:00'))
    await w.tick.run()
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(1)
  })
})

describe('delivery problems', () => {
  it('a failed send is tried again on the next ticks and goes out once when it works; after 5 failures it stops for the day', async () => {
    const w = await world()
    w.appt(w.doc, at('19:00'), 'pending')
    w.fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    for (let i = 0; i < 8; i++) { await w.tick.run(); w.set(new Date(w.clock.now.getTime() + 5 * MIN)) }
    expect(daily(w.emails)).toHaveLength(0)
    expect(dailyKeys(w.db)).toHaveLength(1)
    expect(dailyKeys(w.db)[0]).toMatchObject({ status: 'failed', attempts: 5 }) // stopped at 5 tries
    expect(w.fake.posts.filter((p) => !p.ok)).toHaveLength(5)

    // the admin's button may still try it
    w.fake.replyFor = null
    const r = (await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)).body.result
    expect(r).toMatchObject({ sent: 1, failed: 0 })
    expect(daily(w.emails)).toHaveLength(1)
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(1)
  })

  it('a failure that clears up within the 5 tries is sent on the next tick', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'pending')
    w.fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(0)
    w.fake.replyFor = null
    w.set(new Date(w.clock.now.getTime() + 5 * MIN))
    await w.tick.run()
    w.set(new Date(w.clock.now.getTime() + 5 * MIN))
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(1)
  })

  it('when the email slot is not set up, nothing is sent and nothing is lost: setting it up later in the day sends it', async () => {
    const w = await world({ off: ['email_sender'] })
    w.appt(w.doc, at('10:00'), 'pending')
    expect((await w.tick.run()).daily).toMatchObject({ sent: 0, notSetUp: 1 })
    expect(dailyKeys(w.db)[0].status).toBe('skipped')
    w.db.prepare("INSERT INTO integrations (slot, flow_id, status, webhook_url, flow_title, updated_at) VALUES ('email_sender', 'test-email_sender', 'active', ?, 'email', ?)").run(FLOW_URL('email_sender'), new Date().toISOString())
    w.fake.flows.push({ id: 'test-email_sender', title: 'email', status: 'active', webhook: FLOW_URL('email_sender'), description: '', authId: 'a', serviceId: 's' })
    w.set(new Date(w.clock.now.getTime() + 5 * MIN))
    expect((await w.tick.run()).daily).toMatchObject({ sent: 1, notSetUp: 0 })
    expect(daily(w.emails)).toHaveLength(1)
  })
})

describe('admin: "Send today\'s schedule now"', () => {
  it('sends immediately (even before 8:00 AM) to every doctor with appointments today, and says how many', async () => {
    const w = await world({ now: ist('06:00'), extraDoctor: true })
    w.appt(w.doc, at('10:00'), 'pending')
    w.appt(w.doc2, at('11:00'), 'confirmed')
    expect((await w.tick.run()).daily.due).toBe(false) // the schedule itself waits for 8:00
    const res = await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)
    expect(res.body.result).toEqual({ date: '2026-10-22', due: true, sent: 2, alreadySent: 0, notSetUp: 0, failed: 0, gaveUp: 0, noAppointments: 0 })
    expect(daily(w.emails)).toHaveLength(1)
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(1)
    // 8:00 comes: the tick does not send it again
    w.set(ist('08:00'))
    await w.tick.run()
    expect(daily(w.emails)).toHaveLength(1)
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(1)
  })

  it('only doctors who have not received it yet: a second press sends nothing, and a doctor added to the day later gets theirs', async () => {
    const w = await world({ extraDoctor: true })
    w.appt(w.doc, at('10:00'), 'pending')
    await w.tick.run() // Dr One already got it at 9:30
    const first = (await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)).body.result
    expect(first).toMatchObject({ sent: 0, alreadySent: 1, noAppointments: 1 })
    w.appt(w.doc2, at('15:00'), 'confirmed')
    const second = (await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)).body.result
    expect(second).toMatchObject({ sent: 1, alreadySent: 1, noAppointments: 0 })
    const third = (await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)).body.result
    expect(third).toMatchObject({ sent: 0, alreadySent: 2 })
    expect(daily(w.emails)).toHaveLength(1)
    expect(daily(w.emails, 'doc2@test.local')).toHaveLength(1)
  })

  it('reports an email slot that is not set up instead of claiming it sent', async () => {
    const w = await world({ off: ['email_sender'] })
    w.appt(w.doc, at('10:00'), 'pending')
    const r = (await w.admin.post('/api/admin/daily-schedule/send-now').expect(200)).body.result
    expect(r).toMatchObject({ sent: 0, notSetUp: 1 })
  })

  it('only the admin can press it', async () => {
    const w = await world()
    w.appt(w.doc, at('10:00'), 'pending')
    const doctor = await login(w.app, 'doc@test.local', 'password-123')
    const patient = await login(w.app, 'pat@test.local', 'password-123')
    expect((await doctor.post('/api/admin/daily-schedule/send-now')).status).toBe(403)
    expect((await patient.post('/api/admin/daily-schedule/send-now')).status).toBe(403)
    expect((await agentFor(w.app).post('/api/admin/daily-schedule/send-now')).status).toBe(401)
    expect(daily(w.emails)).toHaveLength(0)
  })
})

describe('admin dashboard: Bookings per doctor adds up', () => {
  it('every status has a column, so the columns add up to Total (also No-show, Expired and Rebooked)', async () => {
    const w = await world()
    const hours = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']
    APPT_STATUSES.forEach((status, i) => w.appt(w.doc, at(hours[i], '2026-10-24'), status))
    w.appt(w.doc, at('12:30', '2026-10-24'), 'completed') // two completed, to see counts above 1
    w.appt(w.doc, at('13:00', '2026-10-24'), 'no_show')
    w.appt(w.doc, at('13:30', '2026-10-24'), 'expired')
    const dash = (await w.admin.get('/api/admin/dashboard').expect(200)).body
    const row = dash.perDoctor.find((d) => d.name === 'Dr One')
    expect(row).toMatchObject({ total: 12, pending: 1, confirmed: 1, completed: 2, noShow: 2, cancelled: 2, needsRebooking: 1, rebooked: 1, expired: 2 })
    const sum = row.pending + row.confirmed + row.completed + row.noShow + row.cancelled + row.needsRebooking + row.rebooked + row.expired
    expect(sum).toBe(row.total)
    expect(APPT_STATUSES).toHaveLength(9) // adding a status means adding its column (this test then fails until the table shows it)
  })
  it('a doctor with no bookings shows zeros', async () => {
    const w = await world()
    const row = (await w.admin.get('/api/admin/dashboard').expect(200)).body.perDoctor[0]
    expect(row).toMatchObject({ total: 0, noShow: 0, expired: 0, rebooked: 0 })
  })
})
