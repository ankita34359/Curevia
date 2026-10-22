import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { HttpError, parse, wrap } from '../lib/http.js'
import { appointmentIcs } from '../lib/ics.js'
import { requireVerifiedPatient } from '../auth/middleware.js'
import { APPT_SELECT, changeStatus, getAppointment, logEvent } from '../services/appointments.js'
import { findBookableSlot, overlapsExisting, rebookOptions } from '../services/scheduling.js'
import { shapeAppointment } from '../services/shape.js'
import { formatIst } from '../lib/time.js'

const bookBody = z.object({
  doctorId: z.number().int().positive(),
  startUtc: z.string().datetime(),
  name: z.string().trim().min(2, 'Enter the patient\'s name').max(100),
  age: z.number().int().min(0, 'Enter a valid age').max(120, 'Enter a valid age'),
  gender: z.enum(['female', 'male', 'other']),
  phone: z.string().trim().regex(/^\+?[\d\s-]{7,16}$/, 'Enter a valid phone number'),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  reason: z.string().trim().min(3, 'Please tell us briefly why you are visiting').max(500)
})
const cancelBody = z.object({ reason: z.string().trim().max(300).optional() })
const rebookBody = z.object({ doctorId: z.number().int().positive(), startUtc: z.string().datetime() })

// needs_rebooking is the normal case. A still-pending request can also be moved, when the agent offers other slots.
const REBOOKABLE = ['needs_rebooking', 'pending']
export const CANCEL_CUTOFF_MS = 60 * 60 * 1000 // patients can cancel up to 1 hour before

class SlotTaken extends HttpError {
  constructor() { super(409, 'Sorry, that slot was just taken. Please pick another time.', { code: 'slot_taken' }) }
}

export function patientRoutes({ db, notifier, clock }) {
  const r = Router()
  const bookLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `patient-${req.user.id}`,
    handler: (_req, res) => res.status(429).json({ error: 'Too many booking attempts. Please try again later.' })
  })

  const full = (id) => db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id)
  const ownRow = (req) => {
    const a = getAppointment(db, Number(req.params.id))
    if (!a || a.patient_id !== req.user.id) throw new HttpError(404, 'Appointment not found') // never reveal other patients' ids
    return a
  }

  // Inserts a booking. The unique index on (doctor, start) is the final guard against double booking.
  function insertAppointment({ patientId, doctorId, slot, details, status, now }) {
    if (overlapsExisting(db, doctorId, slot.startUtc, slot.endUtc)) throw new SlotTaken()
    const t = now.toISOString()
    try {
      const info = db
        .prepare(
          `INSERT INTO appointments (patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, confirmed_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(patientId, doctorId, slot.startUtc, slot.endUtc, status, details.name, details.age, details.gender, details.phone, details.email, details.reason, status === 'confirmed' ? t : null, t, t)
      return Number(info.lastInsertRowid)
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new SlotTaken()
      throw e
    }
  }

  r.post('/appointments', requireVerifiedPatient, bookLimiter, wrap(async (req, res) => {
    const b = parse(bookBody, req.body)
    const now = clock()
    const id = db.transaction(() => {
      const slot = findBookableSlot(db, b.doctorId, b.startUtc, now.toISOString())
      if (!slot) throw new SlotTaken()
      const newId = insertAppointment({ patientId: req.user.id, doctorId: b.doctorId, slot, details: b, status: 'pending', now })
      logEvent(db, newId, 'booked', { to: 'pending', actorRole: 'patient', actorId: req.user.id, now })
      return newId
    })()
    notifier.emit('booked', { appointmentId: id })
    res.status(201).json({ appointment: shapeAppointment(full(id)) })
  }))

  r.get('/appointments', (req, res) => {
    const nowIso = clock().toISOString()
    const rows = db.prepare(`${APPT_SELECT} WHERE a.patient_id = ? ORDER BY a.start_utc`).all(req.user.id).map(shapeAppointment)
    const isUpcoming = (a) => (a.status === 'pending' || a.status === 'confirmed') && a.startUtc > nowIso
    res.json({
      now: nowIso,
      upcoming: rows.filter(isUpcoming),
      needsRebooking: rows.filter((a) => a.status === 'needs_rebooking'),
      past: rows.filter((a) => !isUpcoming(a) && a.status !== 'needs_rebooking').reverse()
    })
  })

  r.get('/appointments/:id', (req, res) => {
    const a = ownRow(req)
    const events = db.prepare('SELECT event, from_status, to_status, actor_role, note, created_at FROM appointment_events WHERE appointment_id = ? ORDER BY id').all(a.id)
    res.json({ appointment: shapeAppointment(full(a.id)), history: events.map((e) => ({ event: e.event, by: e.actor_role, note: e.note, atIst: formatIst(e.created_at) })) })
  })

  r.post('/appointments/:id/cancel', wrap(async (req, res) => {
    const a = ownRow(req)
    const { reason } = parse(cancelBody, req.body ?? {})
    const now = clock()
    if (['pending', 'confirmed'].includes(a.status) && new Date(a.start_utc).getTime() - now.getTime() < CANCEL_CUTOFF_MS) {
      throw new HttpError(409, 'Appointments can be cancelled up to 1 hour before the visit. Please call the hospital instead.', { code: 'too_late' })
    }
    changeStatus(db, a.id, 'cancelled_by_patient', { actorRole: 'patient', actorId: req.user.id, cancelReason: reason || null, note: reason || null, now })
    notifier.emit('cancelled_by_patient', { appointmentId: a.id, reason: reason || null })
    res.json({ appointment: shapeAppointment(full(a.id)) })
  }))

  r.get('/appointments/:id/rebook-options', (req, res) => {
    const a = ownRow(req)
    if (!REBOOKABLE.includes(a.status)) throw new HttpError(409, 'This appointment does not need rebooking')
    const options = rebookOptions(db, a, clock().toISOString()).map((o) => ({ ...o, startIst: formatIst(o.startUtc) }))
    res.json({ appointment: shapeAppointment(full(a.id)), options })
  })

  // The old appointment becomes `rebooked`; the new one keeps the status the old one had (pending or confirmed).
  r.post('/appointments/:id/rebook', wrap(async (req, res) => {
    const old = ownRow(req)
    if (!REBOOKABLE.includes(old.status)) throw new HttpError(409, 'This appointment does not need rebooking')
    const pick = parse(rebookBody, req.body)
    const now = clock()
    const allowed = rebookOptions(db, old, now.toISOString(), { limit: 1000, perDoctor: 1000 })
    if (!allowed.some((o) => o.doctorId === pick.doctorId && o.startUtc === pick.startUtc)) throw new SlotTaken()
    const newId = db.transaction(() => {
      const slot = findBookableSlot(db, pick.doctorId, pick.startUtc, now.toISOString())
      if (!slot) throw new SlotTaken()
      // needs_rebooking keeps the status it had before; a still-pending request moves as pending.
      const status = old.status === 'needs_rebooking' && old.status_before === 'confirmed' ? 'confirmed' : 'pending'
      const id = insertAppointment({ patientId: req.user.id, doctorId: pick.doctorId, slot, details: { name: old.patient_name, age: old.age, gender: old.gender, phone: old.phone, email: old.email, reason: old.reason }, status, now })
      logEvent(db, id, 'booked', { to: status, actorRole: 'patient', actorId: req.user.id, note: `Rebooked from appointment ${old.id}`, now })
      changeStatus(db, old.id, 'rebooked', { actorRole: 'patient', actorId: req.user.id, note: `Moved to appointment ${id}`, now })
      db.prepare('UPDATE appointments SET rebooked_to_id = ? WHERE id = ?').run(id, old.id)
      return id
    })()
    notifier.emit('rebooked', { appointmentId: old.id, newAppointmentId: newId })
    notifier.emit('booked', { appointmentId: newId, viaRebooking: true })
    res.status(201).json({ appointment: shapeAppointment(full(newId)) })
  }))

  r.get('/appointments/:id/calendar.ics', (req, res) => {
    const a = ownRow(req)
    if (!['pending', 'confirmed'].includes(a.status)) throw new HttpError(409, 'Only upcoming appointments can be added to a calendar')
    const f = full(a.id)
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="curevia-appointment-${a.id}.ics"`)
    res.send(appointmentIcs({ id: a.id, startUtc: a.start_utc, endUtc: a.end_utc, doctorName: f.doctor_name, department: f.department, status: a.status, now: clock().toISOString() }))
  })

  return r
}
