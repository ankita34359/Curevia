import { describe, it, expect } from 'vitest'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN } from './helpers.js'

// "Now" in tests is Thursday 22 Oct 2026, 09:30 IST. Friday 23 Oct 09:00 IST == 03:30 UTC.
const FRI_9 = '2026-10-23T03:30:00.000Z'
const FRI_930 = '2026-10-23T04:00:00.000Z'
const details = (doctorId, startUtc, over = {}) => ({ doctorId, startUtc, name: 'Asha Test', age: 31, gender: 'female', phone: '+91 90000 00000', email: 'pat@test.local', reason: 'Fake: persistent cough', ...over })

async function setup(opts) {
  const ctx = await makeApp(opts)
  const doc = addDoctor(ctx.db)
  addPatient(ctx.db)
  const patient = await login(ctx.app, 'pat@test.local', 'password-123')
  return { ...ctx, ...doc, patient }
}
const statusOf = (db, id) => db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status

describe('browsing', () => {
  it('lists active doctors with the next available slot and hides inactive ones', async () => {
    const { app, db, doctorId } = await setup()
    const list = (await agentFor(app).get('/api/public/doctors')).body.doctors
    expect(list).toHaveLength(1)
    expect(list[0].nextAvailable.startUtc).toBe('2026-10-22T04:30:00.000Z') // "now" is Thu 09:30 IST, so the 09:30 slot has started: next is 10:00 IST
    expect(list[0].nextAvailable.startIst).toBe('22 Oct 2026, 10:00 AM')
    db.prepare('UPDATE doctors SET active = 0 WHERE id = ?').run(doctorId)
    expect((await agentFor(app).get('/api/public/doctors')).body.doctors).toHaveLength(0)
    await agentFor(app).get(`/api/public/doctors/${doctorId}`).expect(404)
  })

  it('returns a week of slots; booked and past slots are not free; leave days are empty', async () => {
    const { app, db, doctorId, patient } = await setup()
    await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(201)
    db.prepare("INSERT INTO leaves (doctor_id, date) VALUES (?, '2026-10-26')").run(doctorId)
    const res = (await agentFor(app).get(`/api/public/doctors/${doctorId}/slots?from=2026-10-22`)).body
    const byDate = Object.fromEntries(res.days.map((d) => [d.date, d]))
    expect(byDate['2026-10-22'].slots.find((s) => s.time === '09:00').state).toBe('past')
    expect(byDate['2026-10-23'].slots.find((s) => s.time === '09:00').state).toBe('booked')
    expect(byDate['2026-10-23'].slots.find((s) => s.time === '09:30').state).toBe('free')
    expect(byDate['2026-10-24'].slots).toEqual([]) // Saturday: not working
    expect(byDate['2026-10-26'].slots).toEqual([]) // leave
    expect(res.canGoBack).toBe(false)
  })
})

describe('booking', () => {
  it('books a pending appointment and records the event', async () => {
    const { patient, db, doctorId } = await setup()
    const res = await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9))
    expect(res.status).toBe(201)
    expect(res.body.appointment.status).toBe('pending')
    expect(res.body.appointment.startIst).toBe('23 Oct 2026, 9:00 AM')
    expect(db.prepare('SELECT COUNT(*) n FROM appointment_events WHERE event = ?').get('booked').n).toBe(1)
  })

  it('a slot can never be double-booked: sequential and simultaneous attempts', async () => {
    const { app, db, doctorId, patient } = await setup()
    addPatient(db, 'second@test.local', 'Second')
    const second = await login(app, 'second@test.local', 'password-123')
    await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(201)
    const again = await second.post('/api/patient/appointments').send(details(doctorId, FRI_9))
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('slot_taken')

    const results = await Promise.all([patient, second].map((a) => a.post('/api/patient/appointments').send(details(doctorId, FRI_930))))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(db.prepare('SELECT COUNT(*) n FROM appointments WHERE doctor_id = ? AND start_utc = ?').get(doctorId, FRI_930).n).toBe(1)
  })

  it('the database itself refuses a second active booking for the same slot', async () => {
    const { db, doctorId } = await setup()
    const p = addPatient(db, 'x@test.local')
    addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9 })
    expect(() => addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9 })).toThrow(/UNIQUE/)
    // a cancelled booking releases the slot
    db.prepare("UPDATE appointments SET status = 'cancelled_by_patient'").run()
    expect(() => addAppointment(db, { doctorId, patientId: p, startUtc: FRI_9 })).not.toThrow()
  })

  it('refuses slots the doctor does not offer, past slots, leave days, far-future slots and inactive doctors', async () => {
    const { patient, db, doctorId } = await setup()
    await patient.post('/api/patient/appointments').send(details(doctorId, '2026-10-23T03:45:00.000Z')).expect(409) // 09:15 is not a slot
    await patient.post('/api/patient/appointments').send(details(doctorId, '2026-10-22T03:30:00.000Z')).expect(409) // already past
    await patient.post('/api/patient/appointments').send(details(doctorId, '2026-10-24T04:00:00.000Z')).expect(409) // Saturday
    await patient.post('/api/patient/appointments').send(details(doctorId, '2026-12-25T04:00:00.000Z')).expect(409) // beyond 30 days
    db.prepare("INSERT INTO leaves (doctor_id, date) VALUES (?, '2026-10-23')").run(doctorId)
    await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(409)
    db.prepare('UPDATE doctors SET active = 0').run()
    await patient.post('/api/patient/appointments').send(details(doctorId, FRI_930)).expect(409)
  })

  it('validates the form', async () => {
    const { patient, doctorId } = await setup()
    for (const bad of [{ age: -1 }, { age: 200 }, { gender: 'x' }, { phone: 'abc' }, { email: 'nope' }, { reason: '' }, { name: '' }]) {
      expect((await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9, bad))).status, JSON.stringify(bad)).toBe(400)
    }
  })

  it('needs a signed-in, email-verified patient', async () => {
    const { app, db, doctorId } = await setup()
    await agentFor(app).post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(401)
    db.prepare("UPDATE users SET email_verified_at = NULL WHERE email = 'pat@test.local'").run()
    const unverified = await login(app, 'pat@test.local', 'password-123')
    const res = await unverified.post('/api/patient/appointments').send(details(doctorId, FRI_9))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('email_not_verified')
    const doc = await login(app, 'doc@test.local', 'password-123')
    await doc.post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(403)
  })
})

describe('my appointments', () => {
  it('a patient sees only their own appointments and cannot touch others\'', async () => {
    const { app, db, doctorId, patient } = await setup()
    const other = addPatient(db, 'other@test.local', 'Other')
    const theirs = addAppointment(db, { doctorId, patientId: other, startUtc: FRI_930 })
    await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9)).expect(201)
    const mine = (await patient.get('/api/patient/appointments')).body
    expect(mine.upcoming).toHaveLength(1)
    await patient.get(`/api/patient/appointments/${theirs}`).expect(404)
    await patient.post(`/api/patient/appointments/${theirs}/cancel`).send({}).expect(404)
    await patient.get(`/api/patient/appointments/${theirs}/calendar.ics`).expect(404)
    expect(statusOf(db, theirs)).toBe('pending')
  })

  it('cancels up to one hour before, not later', async () => {
    const { db, doctorId, patient, clock } = await setup()
    const id = addAppointment(db, { doctorId, patientId: db.prepare("SELECT id FROM users WHERE email='pat@test.local'").get().id, startUtc: FRI_9, status: 'confirmed' })
    clock.now = new Date('2026-10-23T02:45:00.000Z') // 08:15 IST: 45 min before
    const late = await patient.post(`/api/patient/appointments/${id}/cancel`).send({})
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('too_late')
    clock.now = new Date('2026-10-23T02:30:00.000Z') // exactly 1 hour before
    await patient.post(`/api/patient/appointments/${id}/cancel`).send({ reason: 'Feeling better' }).expect(200)
    expect(statusOf(db, id)).toBe('cancelled_by_patient')
    await patient.post(`/api/patient/appointments/${id}/cancel`).send({}).expect(409) // already cancelled
  })

  it('downloads a calendar file for an upcoming appointment', async () => {
    const { patient, doctorId } = await setup()
    const id = (await patient.post('/api/patient/appointments').send(details(doctorId, FRI_9))).body.appointment.id
    const res = await patient.get(`/api/patient/appointments/${id}/calendar.ics`)
    expect(res.headers['content-type']).toMatch(/text\/calendar/)
    expect(res.text).toContain('DTSTART:20261023T033000Z')
    expect(res.text).toContain('DTEND:20261023T040000Z')
    expect(res.text).toContain('SUMMARY:Appointment with Dr Test')
    expect(res.text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true)
  })
})

describe('rebooking', () => {
  async function rebookSetup(statusBefore) {
    const ctx = await setup()
    const second = addDoctor(ctx.db, { email: 'doc2@test.local', name: 'Dr Second' })
    const other = addDoctor(ctx.db, { email: 'doc3@test.local', name: 'Dr Elsewhere', dept: 'Other dept' })
    const patientId = ctx.db.prepare("SELECT id FROM users WHERE email='pat@test.local'").get().id
    const id = addAppointment(ctx.db, { doctorId: ctx.doctorId, patientId, startUtc: FRI_9, status: statusBefore })
    const admin = await login(ctx.app, ADMIN.email, ADMIN.password)
    return { ...ctx, second, other, id, admin, patientId }
  }

  it('offers free slots of the same department only, and the new booking keeps the old status', async () => {
    for (const before of ['pending', 'confirmed']) {
      const { patient, db, doctorId, second, other, id, admin } = await rebookSetup(before)
      await admin.post(`/api/admin/doctors/${doctorId}/deactivate`).expect(200)
      expect(statusOf(db, id)).toBe('needs_rebooking')

      const opts = (await patient.get(`/api/patient/appointments/${id}/rebook-options`)).body.options
      expect(opts.length).toBeGreaterThan(0)
      expect(opts.every((o) => o.doctorId === second.doctorId)).toBe(true) // deactivated doctor and other department are excluded
      expect(opts.every((o) => o.doctorId !== other.doctorId)).toBe(true)

      const pick = opts[0]
      const res = await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: pick.doctorId, startUtc: pick.startUtc })
      expect(res.status).toBe(201)
      expect(res.body.appointment.status).toBe(before)
      expect(statusOf(db, id)).toBe('rebooked')
      expect(db.prepare('SELECT rebooked_to_id FROM appointments WHERE id = ?').get(id).rebooked_to_id).toBe(res.body.appointment.id)
      await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: pick.doctorId, startUtc: pick.startUtc }).expect(409) // only once
    }
  })

  it('refuses a slot that is not one of the offered free slots', async () => {
    const { patient, db, doctorId, second, other, id, admin, patientId } = await rebookSetup('pending')
    await admin.post(`/api/admin/doctors/${doctorId}/deactivate`)
    await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: other.doctorId, startUtc: FRI_930 }).expect(409) // other department
    addAppointment(db, { doctorId: second.doctorId, patientId, startUtc: FRI_930 })
    await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: second.doctorId, startUtc: FRI_930 }).expect(409) // taken
  })

  it('a patient can decline rebooking by cancelling', async () => {
    const { patient, db, doctorId, id, admin } = await rebookSetup('confirmed')
    await admin.post(`/api/admin/doctors/${doctorId}/deactivate`)
    await patient.post(`/api/patient/appointments/${id}/cancel`).send({}).expect(200)
    expect(statusOf(db, id)).toBe('cancelled_by_patient')
  })

  it('only needs_rebooking or pending appointments can be moved; a confirmed one cannot', async () => {
    const { patient, db, doctorId, id } = await rebookSetup('confirmed')
    await patient.get(`/api/patient/appointments/${id}/rebook-options`).expect(409)
    await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId, startUtc: FRI_930 }).expect(409)
    expect(statusOf(db, id)).toBe('confirmed')
  })

  it('a still-pending request can be moved to an offered slot and stays pending', async () => {
    const { patient, db, id, second } = await rebookSetup('pending')
    const opts = (await patient.get(`/api/patient/appointments/${id}/rebook-options`)).body.options
    expect(opts.length).toBeGreaterThan(0)
    const res = await patient.post(`/api/patient/appointments/${id}/rebook`).send({ doctorId: second.doctorId, startUtc: opts.find((o) => o.doctorId === second.doctorId).startUtc })
    expect(res.status).toBe(201)
    expect(res.body.appointment.status).toBe('pending')
    expect(statusOf(db, id)).toBe('rebooked')
  })
})
