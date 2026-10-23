import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { migrations } from '../server/db/migrations.js'
import { migrate } from '../server/db/index.js'

const VISIT = '2026-10-21T04:00:00.000Z' // Wed 21 Oct 09:30 IST, before "now" (22 Oct)
const NOTE = 'Collect from Lab counter, ground floor'
const labMails = (emails, to = 'pat@test.local') => emails.sent.filter((m) => m.to === to && m.subject === 'Your lab report is ready')
const labRows = (w) => w.fake.postsTo('appointments_sheet').filter((p) => p.event === 'lab_report_ready')

async function world({ status = 'completed', off } = {}) {
  const w = await makeApp({ off })
  const doc = addDoctor(w.db, { email: 'doc@test.local', name: 'Dr One' })
  const other = addDoctor(w.db, { email: 'doc2@test.local', name: 'Dr Two', dept: 'Cardiology' })
  const patientId = addPatient(w.db, 'pat@test.local', 'Asha Patient')
  const id = addAppointment(w.db, { doctorId: doc.doctorId, patientId, startUtc: VISIT, status, name: 'Asha Patient' })
  return {
    ...w, id, doc, other, patientId,
    doctor: await login(w.app, 'doc@test.local', 'password-123'),
    patient: await login(w.app, 'pat@test.local', 'password-123'),
    admin: await login(w.app, ADMIN.email, ADMIN.password),
    mark: async (agent, body, id2) => { const r = await agent.post(`/api/doctor/appointments/${id2 ?? id}/lab-report`).send(body); await w.notifier.flush(); return r }
  }
}

describe('doctor marks the lab report ready', () => {
  it('works on a completed appointment: one email to the patient, one sheet row, shown on the appointment', async () => {
    const w = await world()
    const r = await w.mark(w.doctor, { note: NOTE })
    expect(r.status).toBe(200)
    expect(r.body.appointment.labReport).toMatchObject({ note: NOTE })
    expect(r.body.appointment.labReport.readyIst).toMatch(/22 Oct 2026/)
    expect(r.body.appointment.status).toBe('completed') // the visit itself is unchanged

    const mail = labMails(w.emails)
    expect(mail).toHaveLength(1)
    expect(mail[0].body).toContain('Dr One')
    expect(mail[0].body).toContain('21 Oct 2026') // the date of the visit
    expect(mail[0].body).toContain(NOTE)
    expect(mail[0].body).toMatch(/collect your report from the lab/)
    expect(mail[0].body).toContain(`${w.config.appUrl}/my`)
    expect(w.emails.sent.filter((m) => m.to === 'doc@test.local')).toHaveLength(0)

    const rows = labRows(w)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ appointment_id: w.id, patient_name: 'Asha Patient', doctor: 'Dr One', status: 'completed', event: 'lab_report_ready' })
    expect(w.db.prepare("SELECT channel, type, dedupe_key, status FROM deliveries WHERE type IN ('patient_lab_report_ready','lab_report_ready') ORDER BY channel").all()).toEqual([
      { channel: 'email', type: 'patient_lab_report_ready', dedupe_key: `email:patient_lab_report_ready:${w.id}`, status: 'sent' },
      { channel: 'sheet', type: 'lab_report_ready', dedupe_key: `sheet:lab_report_ready:${w.id}`, status: 'sent' }
    ])
    expect(w.fake.postsTo('slack_alert')).toHaveLength(0) // nobody is alerted in Slack
  })

  it('the note is optional; without one the email just says it is ready', async () => {
    const w = await world()
    for (const body of [undefined, {}, { note: '   ' }]) {
      const x = await world()
      const r = await x.mark(x.doctor, body)
      expect(r.status).toBe(200)
      expect(r.body.appointment.labReport.note).toBe('')
      expect(labMails(x.emails)[0].body).not.toMatch(/Note from your doctor/)
    }
    expect(w.id).toBe(1)
  })

  it('a note is trimmed, limited to 200 characters, and cannot inject HTML into the email', async () => {
    const w = await world()
    expect((await w.mark(w.doctor, { note: 'x'.repeat(201) })).status).toBe(400)
    expect(w.db.prepare('SELECT COUNT(*) n FROM lab_reports').get().n).toBe(0)
    expect(labMails(w.emails)).toHaveLength(0)
    const r = await w.mark(w.doctor, { note: '  <b>Ground floor</b> <script>alert(1)</script>  ' })
    expect(r.status).toBe(200)
    const body = labMails(w.emails)[0].body
    expect(body).not.toContain('<script>')
    expect(body).toContain('&lt;b&gt;Ground floor&lt;/b&gt;')
    expect(r.body.appointment.labReport.note.startsWith('<b>')).toBe(true) // trimmed, stored as typed, escaped when shown
  })

  it('takes only a note: no results, no file, nothing else is stored or sent', async () => {
    const w = await world()
    await w.mark(w.doctor, { note: 'Ground floor', results: 'HbA1c 9.1', file: 'data:application/pdf;base64,AAAA', value: 42 })
    const stored = w.db.prepare('SELECT * FROM lab_reports').get()
    expect(Object.keys(stored).sort()).toEqual(['appointment_id', 'created_at', 'marked_by', 'note'])
    expect(JSON.stringify([labMails(w.emails), labRows(w)])).not.toMatch(/HbA1c|AAAA/)
  })

  it('can be done only once: a second try (or two at the same moment) changes nothing and sends nothing more', async () => {
    const w = await world()
    const both = await Promise.all([w.mark(w.doctor, { note: 'First' }), w.mark(w.doctor, { note: 'Second' })])
    expect(both.map((r) => r.status).sort()).toEqual([200, 409])
    const again = await w.mark(w.doctor, { note: 'Third' })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already marked ready/)
    expect(w.db.prepare('SELECT COUNT(*) n FROM lab_reports').get().n).toBe(1)
    expect(labMails(w.emails)).toHaveLength(1)
    expect(labRows(w)).toHaveLength(1)
    await w.tick.run() // ticks never repeat it either
    expect(labMails(w.emails)).toHaveLength(1)
  })

  it('only a completed appointment: not pending, confirmed, no-show, cancelled or needing a new slot', async () => {
    for (const status of ['pending', 'confirmed', 'no_show', 'cancelled_by_patient', 'cancelled_by_doctor', 'needs_rebooking', 'expired', 'rebooked']) {
      const w = await world({ status })
      const r = await w.mark(w.doctor, { note: NOTE })
      expect(r.status, status).toBe(409)
      expect(r.body.error).toMatch(/only on a completed appointment/)
      expect(w.db.prepare('SELECT COUNT(*) n FROM lab_reports').get().n).toBe(0)
      expect(labMails(w.emails)).toHaveLength(0)
    }
  })

  it('an appointment that does not exist is a 404', async () => {
    const w = await world()
    expect((await w.mark(w.doctor, {}, 9999)).status).toBe(404)
  })
})

describe('who can mark it', () => {
  it('only the doctor of that appointment: other doctors, the patient, the admin and anonymous visitors cannot', async () => {
    const w = await world()
    const otherDoctor = await login(w.app, 'doc2@test.local', 'password-123')
    expect((await w.mark(otherDoctor, { note: 'Not mine' })).status).toBe(404) // not even confirmed to exist
    expect((await w.mark(w.patient, { note: 'I am the patient' })).status).toBe(403)
    expect((await w.mark(w.admin, { note: 'I am the admin' })).status).toBe(403)
    expect((await w.mark(agentFor(w.app), { note: 'Anyone' })).status).toBe(401)
    expect(w.db.prepare('SELECT COUNT(*) n FROM lab_reports').get().n).toBe(0)
    expect(labMails(w.emails)).toHaveLength(0)
    expect(labRows(w)).toHaveLength(0)
    expect((await w.mark(w.doctor, { note: NOTE })).status).toBe(200) // the right doctor still can
  })
})

describe('where it shows', () => {
  it('Visit history: the patient sees it (with the note) once marked, only on their own visit', async () => {
    const w = await world()
    let mine = (await w.patient.get('/api/patient/appointments').expect(200)).body
    expect(mine.past[0].labReport).toBeNull()
    await w.mark(w.doctor, { note: NOTE })
    mine = (await w.patient.get('/api/patient/appointments').expect(200)).body
    expect(mine.past).toHaveLength(1)
    expect(mine.past[0]).toMatchObject({ id: w.id, status: 'completed', labReport: { note: NOTE } })
    const stranger = addPatient(w.db, 'other@test.local', 'Other Person')
    expect(stranger).toBeGreaterThan(0)
    const otherPatient = await login(w.app, 'other@test.local', 'password-123')
    expect(JSON.stringify((await otherPatient.get('/api/patient/appointments').expect(200)).body)).not.toContain(NOTE)
  })

  it('the doctor sees it on their own lists; other doctors do not', async () => {
    const w = await world()
    await w.mark(w.doctor, { note: NOTE })
    const past = (await w.doctor.get('/api/doctor/appointments?scope=past').expect(200)).body.appointments
    expect(past.find((a) => a.id === w.id).labReport).toMatchObject({ note: NOTE })
    const otherDoctor = await login(w.app, 'doc2@test.local', 'password-123')
    expect((await otherDoctor.get('/api/doctor/appointments?scope=past').expect(200)).body.appointments).toHaveLength(0)
  })

  it('Admin dashboard: the appointments list carries the lab report status', async () => {
    const w = await world()
    const second = addAppointment(w.db, { doctorId: w.doc.doctorId, patientId: w.patientId, startUtc: '2026-10-20T04:00:00.000Z', status: 'completed' })
    const third = addAppointment(w.db, { doctorId: w.doc.doctorId, patientId: w.patientId, startUtc: '2026-10-19T04:00:00.000Z', status: 'no_show' })
    await w.mark(w.doctor, { note: NOTE })
    const list = (await w.admin.get('/api/admin/appointments').expect(200)).body.appointments
    const byId = Object.fromEntries(list.map((a) => [a.id, a]))
    expect(byId[w.id].labReport).toMatchObject({ note: NOTE })
    expect(byId[second].labReport).toBeNull() // completed, not marked yet
    expect(byId[third].labReport).toBeNull()
    expect(w.db.prepare("SELECT COUNT(*) n FROM appointment_events WHERE event = 'lab_report_ready'").get().n).toBe(0)
  })
})

describe('email delivery', () => {
  it('a failed email is retried on the next tick and still sent only once; the sheet row is not repeated', async () => {
    const w = await world()
    w.fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    expect((await w.mark(w.doctor, { note: NOTE })).status).toBe(200) // marked even though the email failed
    expect(labMails(w.emails)).toHaveLength(0)
    expect(w.db.prepare("SELECT status FROM deliveries WHERE type = 'patient_lab_report_ready'").get().status).toBe('failed')
    w.fake.replyFor = null
    await w.tick.run()
    await w.tick.run()
    expect(labMails(w.emails)).toHaveLength(1)
    expect(labMails(w.emails)[0].body).toContain(NOTE) // rebuilt from what is stored
    expect(labRows(w)).toHaveLength(1)
  })

  it('works when email and the sheet are not set up yet: it is still marked, and the sends are recorded as skipped', async () => {
    const w = await world({ off: ['email_sender', 'appointments_sheet'] })
    expect((await w.mark(w.doctor, { note: NOTE })).status).toBe(200)
    expect(w.db.prepare("SELECT channel, status FROM deliveries WHERE type IN ('patient_lab_report_ready','lab_report_ready') ORDER BY channel").all()).toEqual([
      { channel: 'email', status: 'skipped' }, { channel: 'sheet', status: 'skipped' }
    ])
  })
})

describe('the AI agent does not handle lab reports', () => {
  it('a completed appointment is no case for the agent, and marking a report starts nothing', async () => {
    const w = await world()
    w.fake.ai = () => ({ content: { action: 'wait', reason: 'x', wait_minutes: 30, slot_option_ids: [], email_note: '' }, finishReason: 'completed' })
    await w.mark(w.doctor, { note: NOTE })
    const r = await w.tick.run()
    expect(r.agent).toMatchObject({ cases: 0, decisions: 0 })
    expect(w.fake.aiCalls).toHaveLength(0)
    expect(w.db.prepare('SELECT COUNT(*) n FROM agent_cases').get().n).toBe(0)
    expect(w.db.prepare('SELECT COUNT(*) n FROM agent_log').get().n).toBe(0)
  })
})

describe('database', () => {
  it('lab_reports is one row per appointment, and migration 6 only adds the table (v5 data is untouched)', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    for (const m of migrations.filter((x) => x.id <= 5)) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.id, m.name, 't')
    }
    const T = '2026-10-20T10:00:00.000Z'
    db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('doctor','d@x.test','D',?)").run(T)
    db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('patient','p@x.test','P',?)").run(T)
    db.prepare("INSERT INTO departments (name, created_at) VALUES ('G', ?)").run(T)
    db.prepare('INSERT INTO doctors (user_id, department_id, created_at) VALUES (1, 1, ?)').run(T)
    db.prepare("INSERT INTO appointments (patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, created_at, updated_at) VALUES (2,1,?,?,'completed','P',1,'x','1','e','r',?,?)").run(T, T, T, T)
    const before = db.prepare('SELECT * FROM appointments').all()
    migrate(db)
    expect(db.prepare('SELECT MAX(id) v FROM schema_migrations').get().v).toBe(migrations.length) // 6 added the lab_reports table; later ones only add tables too
    expect(db.prepare('SELECT * FROM appointments').all()).toEqual(before)
    db.prepare("INSERT INTO lab_reports (appointment_id, note, marked_by, created_at) VALUES (1, 'n', 1, ?)").run(T)
    expect(() => db.prepare("INSERT INTO lab_reports (appointment_id, note, marked_by, created_at) VALUES (1, 'again', 1, ?)").run(T)).toThrow(/UNIQUE|PRIMARY/)
    expect(() => db.prepare("INSERT INTO lab_reports (appointment_id, note, created_at) VALUES (999, '', ?)").run(T)).toThrow(/FOREIGN KEY/)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
