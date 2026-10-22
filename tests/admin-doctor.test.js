import { describe, it, expect } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, linkToken, ADMIN } from './helpers.js'

// Friday 23 Oct 2026, 09:00 IST == 03:30 UTC. "Now" in tests is Thursday 22 Oct 2026, 09:30 IST.
const FRI_9 = '2026-10-23T03:30:00.000Z'
const FRI_930 = '2026-10-23T04:00:00.000Z'
const doctorBody = (over = {}) => ({ name: 'Dr New', email: 'new@test.local', departmentId: 1, qualification: 'MBBS', experienceYears: 5, fee: 500, languages: 'English, Hindi', photoUrl: '', about: 'Fake', ...over })

describe('admin: doctors and departments', () => {
  it('creates a doctor and emails a set-password link; the doctor can then sign in', async () => {
    const { app, db, emails } = await makeApp()
    db.prepare("INSERT INTO departments (name, created_at) VALUES ('General', ?)").run(new Date().toISOString())
    const admin = await login(app, ADMIN.email, ADMIN.password)
    const res = await admin.post('/api/admin/doctors').send(doctorBody())
    expect(res.status).toBe(201)
    expect(res.body.emailStatus).toBe('sent')
    expect(res.body.setPasswordLink).toBeNull() // only shown to the admin when email did not go out
    expect(res.body.doctor.languages).toEqual(['English', 'Hindi'])
    const token = linkToken(emails.sent[0].body)
    await agentFor(app).post('/api/auth/set-password').send({ token, password: 'doctor-pass-1' }).expect(200)
    const doc = await login(app, 'new@test.local', 'doctor-pass-1')
    expect((await doc.get('/api/doctor/me')).body.doctor.name).toBe('Dr New')
  })

  it('shows the link to the admin when email is not set up', async () => {
    const { app, db } = await makeApp({ noEmail: true })
    db.prepare("INSERT INTO departments (name, created_at) VALUES ('General', ?)").run(new Date().toISOString())
    const admin = await login(app, ADMIN.email, ADMIN.password)
    const res = await admin.post('/api/admin/doctors').send(doctorBody())
    expect(res.body.emailStatus).toBe('skipped')
    expect(res.body.setPasswordLink).toMatch(/\/set-password\?token=/)
    const token = new URL(res.body.setPasswordLink).searchParams.get('token')
    await agentFor(app).post('/api/auth/set-password').send({ token, password: 'doctor-pass-1' }).expect(200)
  })

  it('validates input and refuses duplicate emails', async () => {
    const { app, db } = await makeApp()
    db.prepare("INSERT INTO departments (name, created_at) VALUES ('General', ?)").run(new Date().toISOString())
    const admin = await login(app, ADMIN.email, ADMIN.password)
    await admin.post('/api/admin/doctors').send(doctorBody({ email: 'not-an-email' })).expect(400)
    await admin.post('/api/admin/doctors').send(doctorBody({ photoUrl: 'javascript:alert(1)' })).expect(400)
    await admin.post('/api/admin/doctors').send(doctorBody({ departmentId: 99 })).expect(400)
    await admin.post('/api/admin/doctors').send(doctorBody()).expect(201)
    await admin.post('/api/admin/doctors').send(doctorBody({ name: 'Other' })).expect(409)
  })

  it('manages departments', async () => {
    const { app } = await makeApp()
    const admin = await login(app, ADMIN.email, ADMIN.password)
    await admin.post('/api/admin/departments').send({ name: 'Cardiology', icon: 'heart' }).expect(201)
    await admin.post('/api/admin/departments').send({ name: 'cardiology' }).expect(409)
    const list = (await admin.get('/api/admin/departments')).body.departments
    await admin.patch(`/api/admin/departments/${list[0].id}`).send({ active: false }).expect(200)
    expect((await admin.get('/api/admin/departments')).body.departments[0].active).toBe(false)
  })

  it('deactivating a doctor moves upcoming appointments to needs_rebooking and blocks login', async () => {
    const { app, db, notifier } = await makeApp()
    const { doctorId } = addDoctor(db)
    const p = addPatient(db)
    const pending = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'pending' })
    const confirmed = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_930, status: 'confirmed' })
    const past = addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-20T04:00:00.000Z', status: 'completed' })
    const doc = await login(app, 'doc@test.local', 'password-123')
    const admin = await login(app, ADMIN.email, ADMIN.password)

    const res = await admin.post(`/api/admin/doctors/${doctorId}/deactivate`)
    expect(res.status).toBe(200)
    expect(res.body.movedToRebooking).toBe(2)
    const status = (id) => db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status
    expect(status(pending)).toBe('needs_rebooking')
    expect(status(confirmed)).toBe('needs_rebooking')
    expect(status(past)).toBe('completed')
    expect(db.prepare('SELECT status_before FROM appointments WHERE id = ?').get(confirmed).status_before).toBe('confirmed')
    expect((await doc.get('/api/auth/me')).body.user).toBeNull()
    await agentFor(app).post('/api/auth/login').send({ email: 'doc@test.local', password: 'password-123' }).expect(401)
    await notifier.flush()
  })
})

describe('admin: dashboard and CSV', () => {
  it('counts cards, bookings per doctor and exports CSV safely', async () => {
    const { app, db } = await makeApp()
    const { doctorId } = addDoctor(db)
    const p = addPatient(db)
    addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'pending' })
    addAppointment(db, { doctorId, patientId: p, startUtc: FRI_930, status: 'confirmed' })
    addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-22T05:00:00.000Z', status: 'confirmed', name: '=HYPERLINK("x")' }) // today
    addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-26T05:00:00.000Z', status: 'cancelled_by_patient' })
    const admin = await login(app, ADMIN.email, ADMIN.password)
    const d = (await admin.get('/api/admin/dashboard')).body
    expect(d.cards).toMatchObject({ today: 1, pending: 1, confirmed: 2, cancelled: 1 })
    expect(d.perDoctor[0]).toMatchObject({ total: 4, pending: 1, confirmed: 2, cancelled: 1 })

    const csv = await admin.get('/api/admin/appointments.csv?status=confirmed')
    expect(csv.headers['content-type']).toMatch(/text\/csv/)
    expect(csv.text).toContain('Appointment ID,Patient')
    expect(csv.text).toContain(`'=HYPERLINK(""x"")`) // formula neutralised
    expect(csv.text.trim().split('\r\n')).toHaveLength(3)
  })
})

describe('doctor: own appointments only', () => {
  it('sees only their own, and cannot act on another doctor\'s appointment', async () => {
    const { app, db } = await makeApp()
    const a = addDoctor(db, { email: 'a@test.local' })
    const b = addDoctor(db, { email: 'b@test.local' })
    const p = addPatient(db)
    const mine = addAppointment(db, { doctorId: a.doctorId, patientId: p, startUtc: FRI_9 })
    const theirs = addAppointment(db, { doctorId: b.doctorId, patientId: p, startUtc: FRI_9 })
    const docA = await login(app, 'a@test.local', 'password-123')
    const list = (await docA.get('/api/doctor/appointments?scope=pending')).body.appointments
    expect(list.map((x) => x.id)).toEqual([mine])
    await docA.post(`/api/doctor/appointments/${theirs}/confirm`).expect(404)
    await docA.post(`/api/doctor/appointments/${theirs}/cancel`).send({ reason: 'nope nope' }).expect(404)
    expect(db.prepare('SELECT status FROM appointments WHERE id = ?').get(theirs).status).toBe('pending')
  })

  it('patients and admins cannot use doctor endpoints', async () => {
    const { app, db } = await makeApp()
    addPatient(db)
    const patient = await login(app, 'pat@test.local', 'password-123')
    const admin = await login(app, ADMIN.email, ADMIN.password)
    await patient.get('/api/doctor/appointments?scope=today').expect(403)
    await admin.get('/api/doctor/appointments?scope=today').expect(403)
    await patient.get('/api/admin/dashboard').expect(403)
  })
})

describe('doctor: confirm, cancel, complete', () => {
  async function setup() {
    const ctx = await makeApp()
    const { doctorId } = addDoctor(ctx.db)
    const p = addPatient(ctx.db)
    const doc = await login(ctx.app, 'doc@test.local', 'password-123')
    return { ...ctx, doctorId, p, doc }
  }
  const statusOf = (db, id) => db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status

  it('confirms a pending appointment once', async () => {
    const { db, doctorId, p, doc } = await setup()
    const id = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9 })
    expect((await doc.post(`/api/doctor/appointments/${id}/confirm`)).body.appointment.status).toBe('confirmed')
    await doc.post(`/api/doctor/appointments/${id}/confirm`).expect(409)
    expect(db.prepare('SELECT COUNT(*) n FROM appointment_events WHERE appointment_id = ?').get(id).n).toBe(1)
  })

  it('cancel needs a reason; the tick-box decides needs_rebooking or cancelled_by_doctor', async () => {
    const { db, doctorId, p, doc } = await setup()
    const a = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9 })
    const b = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_930, status: 'confirmed' })
    await doc.post(`/api/doctor/appointments/${a}/cancel`).send({ reason: '' }).expect(400)
    await doc.post(`/api/doctor/appointments/${a}/cancel`).send({ reason: 'Emergency surgery', offerRebooking: true }).expect(200)
    await doc.post(`/api/doctor/appointments/${b}/cancel`).send({ reason: 'Not available', offerRebooking: false }).expect(200)
    expect(statusOf(db, a)).toBe('needs_rebooking')
    expect(statusOf(db, b)).toBe('cancelled_by_doctor')
    expect(db.prepare('SELECT cancel_reason FROM appointments WHERE id = ?').get(a).cancel_reason).toBe('Emergency surgery')
  })

  it('completed / no-show only once the appointment has started, and only from confirmed', async () => {
    const { db, doctorId, p, doc, clock } = await setup()
    const id = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'confirmed' })
    await doc.post(`/api/doctor/appointments/${id}/complete`).expect(409) // still in the future
    clock.now = new Date('2026-10-23T04:30:00.000Z')
    await doc.post(`/api/doctor/appointments/${id}/complete`).expect(200)
    await doc.post(`/api/doctor/appointments/${id}/no-show`).expect(409)
    const pend = addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-23T05:00:00.000Z' })
    await doc.post(`/api/doctor/appointments/${pend}/no-show`).expect(409) // pending cannot become no_show
  })
})

describe('doctor: availability and leave change existing appointments', () => {
  async function setup() {
    const ctx = await makeApp()
    const { doctorId } = addDoctor(ctx.db)
    const p = addPatient(ctx.db)
    const doc = await login(ctx.app, 'doc@test.local', 'password-123')
    return { ...ctx, doctorId, p, doc }
  }
  const win = (weekday, start, end, slotMinutes = 30) => ({ weekday, start, end, slotMinutes })
  const statusOf = (db, id) => db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status

  it('changed hours: appointments that no longer fit become needs_rebooking, others stay', async () => {
    const { db, doctorId, p, doc, notifier } = await setup()
    const early = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'confirmed' }) // Fri 09:00 IST
    const late = addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-23T05:30:00.000Z', status: 'pending' }) // Fri 11:00 IST
    const windows = [1, 2, 3, 4].map((d) => win(d, '09:00', '12:00')).concat([win(5, '10:00', '12:00')]) // Friday now starts at 10:00
    const res = await doc.put('/api/doctor/availability').send({ windows })
    expect(res.status).toBe(200)
    expect(res.body.movedToRebooking).toBe(1)
    expect(statusOf(db, early)).toBe('needs_rebooking')
    expect(statusOf(db, late)).toBe('pending')
    await notifier.flush()
  })

  it('a longer slot length no longer fits existing bookings', async () => {
    const { db, doctorId, p, doc } = await setup()
    const id = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'pending' })
    const windows = [1, 2, 3, 4, 5].map((d) => win(d, '09:00', '12:00', 20))
    expect((await doc.put('/api/doctor/availability').send({ windows })).body.movedToRebooking).toBe(1)
    expect(statusOf(db, id)).toBe('needs_rebooking')
  })

  it('preview reports the effect without changing anything', async () => {
    const { db, doctorId, p, doc } = await setup()
    const id = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'pending' })
    const res = await doc.put('/api/doctor/availability?preview=1').send({ windows: [win(1, '09:00', '12:00')] })
    expect(res.body.movedToRebooking).toBe(1)
    expect(res.body.preview).toBe(true)
    expect(statusOf(db, id)).toBe('pending')
    expect((await doc.get('/api/doctor/me')).body.availability).toHaveLength(5)
  })

  it('adding leave moves that day\'s appointments', async () => {
    const { db, doctorId, p, doc } = await setup()
    const fri = addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9, status: 'confirmed' })
    const mon = addAppointment(db, { doctorId, patientId: p, startUtc: '2026-10-26T03:30:00.000Z', status: 'confirmed' })
    await doc.post('/api/doctor/leaves').send({ date: '2026-10-21' }).expect(400) // past
    const res = await doc.post('/api/doctor/leaves').send({ date: '2026-10-23', reason: 'Conference' })
    expect(res.status).toBe(201)
    expect(res.body.movedToRebooking).toBe(1)
    expect(statusOf(db, fri)).toBe('needs_rebooking')
    expect(statusOf(db, mon)).toBe('confirmed')
    await doc.post('/api/doctor/leaves').send({ date: '2026-10-23' }).expect(409)
    await doc.delete(`/api/doctor/leaves/${res.body.leaves[0].id}`).expect(200)
  })

  it('rejects overlapping or too-short blocks', async () => {
    const { doc } = await setup()
    await doc.put('/api/doctor/availability').send({ windows: [win(1, '09:00', '12:00'), win(1, '11:00', '13:00')] }).expect(400)
    await doc.put('/api/doctor/availability').send({ windows: [win(1, '09:00', '09:10', 30)] }).expect(400)
    await doc.put('/api/doctor/availability').send({ windows: [{ weekday: 9, start: '09:00', end: '12:00', slotMinutes: 30 }] }).expect(400)
  })
})

describe('password reset', () => {
  it('emails a one-hour link, always answers the same, and never touches the admin', async () => {
    const { app, db, emails } = await makeApp()
    addPatient(db)
    const a = agentFor(app)
    const known = await a.post('/api/auth/forgot-password').send({ email: 'pat@test.local' })
    const unknown = await a.post('/api/auth/forgot-password').send({ email: 'nobody@test.local' })
    await a.post('/api/auth/forgot-password').send({ email: ADMIN.email })
    expect(known.body).toEqual(unknown.body)
    expect(emails.sent).toHaveLength(1)
    const token = linkToken(emails.sent[0].body)
    await a.post('/api/auth/set-password').send({ token, password: 'brand-new-pass' }).expect(200)
    await agentFor(app).post('/api/auth/login').send({ email: 'pat@test.local', password: 'brand-new-pass' }).expect(200)
  })

  it('reset links expire after an hour', async () => {
    const { app, db, emails, clock } = await makeApp()
    addPatient(db)
    await agentFor(app).post('/api/auth/forgot-password').send({ email: 'pat@test.local' })
    const token = linkToken(emails.sent[0].body)
    const row = db.prepare("SELECT expires_at, created_at FROM auth_tokens WHERE type = 'reset_password'").get()
    expect(new Date(row.expires_at) - new Date(row.created_at)).toBe(3600000)
    db.prepare("UPDATE auth_tokens SET expires_at = ? WHERE type = 'reset_password'").run(new Date(Date.now() - 1000).toISOString())
    await agentFor(app).post('/api/auth/set-password').send({ token, password: 'brand-new-pass' }).expect(400)
  })
})
