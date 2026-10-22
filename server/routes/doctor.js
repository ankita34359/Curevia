import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse, wrap } from '../lib/http.js'
import { addDays, isDateStr, isTimeStr, istDate, istToUtcIso, timeToMinutes } from '../lib/time.js'
import { APPT_SELECT, changeStatus, getAppointment, revalidateDoctor } from '../services/appointments.js'
import { shapeAppointment } from '../services/shape.js'
import { getDoctor, shapeDoctor } from '../services/doctors.js'

const windowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start: z.string().refine(isTimeStr, 'Use HH:MM'),
  end: z.string().refine(isTimeStr, 'Use HH:MM'),
  slotMinutes: z.number().int().min(5).max(120)
})
const availabilityBody = z.object({ windows: z.array(windowSchema).max(40) })
const leaveBody = z.object({ date: z.string().refine(isDateStr, 'Use YYYY-MM-DD'), reason: z.string().trim().max(200).default('') })
const cancelBody = z.object({ reason: z.string().trim().min(3, 'Please give a short reason').max(300), offerRebooking: z.boolean().default(true) })

class Rollback extends Error {}

export function doctorRoutes({ db, notifier, clock }) {
  const r = Router()

  // Every handler works on the signed-in doctor's own row; ids in URLs only ever select among their appointments.
  r.use((req, _res, next) => {
    req.doctor = db.prepare('SELECT * FROM doctors WHERE user_id = ?').get(req.user.id)
    if (!req.doctor) return next(new HttpError(403, 'No doctor profile for this account'))
    next()
  })

  const availabilityRows = (id) =>
    db.prepare('SELECT id, weekday, start_time AS start, end_time AS end, slot_minutes AS slotMinutes FROM availability WHERE doctor_id = ? ORDER BY weekday, start_time').all(id)
  const leaveRows = (id) => db.prepare('SELECT id, date, reason FROM leaves WHERE doctor_id = ? AND date >= ? ORDER BY date').all(id, istDate(clock().toISOString()))

  r.get('/me', (req, res) => {
    res.json({ doctor: shapeDoctor(getDoctor(db, req.doctor.id)), availability: availabilityRows(req.doctor.id), leaves: leaveRows(req.doctor.id) })
  })

  // ---- appointments ----
  r.get('/appointments', (req, res) => {
    const scope = parse(z.object({ scope: z.enum(['today', 'pending', 'upcoming', 'past']) }), req.query).scope
    const now = clock().toISOString()
    const today = istDate(now)
    const dayStart = istToUtcIso(today, '00:00')
    const dayEnd = istToUtcIso(addDays(today, 1), '00:00')
    const base = `${APPT_SELECT} WHERE a.doctor_id = ?`
    let rows
    if (scope === 'today') rows = db.prepare(`${base} AND a.start_utc >= ? AND a.start_utc < ? AND a.status IN ('pending','confirmed','completed','no_show') ORDER BY a.start_utc`).all(req.doctor.id, dayStart, dayEnd)
    else if (scope === 'pending') rows = db.prepare(`${base} AND a.status = 'pending' AND a.start_utc > ? ORDER BY a.start_utc`).all(req.doctor.id, now)
    else if (scope === 'upcoming') rows = db.prepare(`${base} AND a.start_utc >= ? AND a.status IN ('pending','confirmed','needs_rebooking') ORDER BY a.start_utc LIMIT 200`).all(req.doctor.id, dayEnd)
    else rows = db.prepare(`${base} AND a.start_utc < ? ORDER BY a.start_utc DESC LIMIT 100`).all(req.doctor.id, now)
    res.json({ appointments: rows.map(shapeAppointment) })
  })

  const own = (req) => {
    const a = getAppointment(db, Number(req.params.id))
    if (!a || a.doctor_id !== req.doctor.id) throw new HttpError(404, 'Appointment not found') // 404, not 403: never confirm that other doctors' ids exist
    return a
  }
  const respond = (res, id) => res.json({ appointment: shapeAppointment(db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id)) })

  r.post('/appointments/:id/confirm', wrap(async (req, res) => {
    const a = own(req)
    if (a.start_utc <= clock().toISOString()) throw new HttpError(409, 'This appointment time has already passed')
    changeStatus(db, a.id, 'confirmed', { actorRole: 'doctor', actorId: req.user.id, now: clock() })
    notifier.emit('confirmed', { appointmentId: a.id })
    respond(res, a.id)
  }))

  // "Offer the patient another slot" -> needs_rebooking; otherwise a final cancellation. Both keep the reason.
  r.post('/appointments/:id/cancel', wrap(async (req, res) => {
    const a = own(req)
    const { reason, offerRebooking } = parse(cancelBody, req.body)
    const to = offerRebooking ? 'needs_rebooking' : 'cancelled_by_doctor'
    changeStatus(db, a.id, to, { actorRole: 'doctor', actorId: req.user.id, cancelReason: reason, note: reason, now: clock() })
    notifier.emit(to, { appointmentId: a.id, reason })
    respond(res, a.id)
  }))

  for (const [path, to] of [['complete', 'completed'], ['no-show', 'no_show']]) {
    r.post(`/appointments/:id/${path}`, wrap(async (req, res) => {
      const a = own(req)
      if (a.start_utc > clock().toISOString()) throw new HttpError(409, 'You can mark this only once the appointment time has started')
      changeStatus(db, a.id, to, { actorRole: 'doctor', actorId: req.user.id, now: clock() })
      notifier.emit(to, { appointmentId: a.id })
      respond(res, a.id)
    }))
  }

  // ---- availability ----
  function validateWindows(windows) {
    for (const w of windows) {
      if (timeToMinutes(w.end) - timeToMinutes(w.start) < w.slotMinutes) throw new HttpError(400, 'Each time block must be at least one slot long')
    }
    for (let day = 0; day < 7; day++) {
      const ws = windows.filter((w) => w.weekday === day).sort((a, b) => a.start.localeCompare(b.start))
      for (let i = 1; i < ws.length; i++) if (ws[i].start < ws[i - 1].end) throw new HttpError(400, 'Time blocks on the same day cannot overlap')
    }
  }
  // Applies a change, reports which appointments no longer fit, and (for a preview) rolls everything back.
  function applyChange(doctorId, change, { preview, actorId }) {
    let moved = []
    try {
      db.transaction(() => {
        change()
        moved = revalidateDoctor(db, doctorId, { actorRole: 'doctor', actorId, note: 'Doctor changed availability or leave', now: clock() })
        if (preview) throw new Rollback()
      })()
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
    return moved
  }
  const previewFlag = (req) => req.query.preview === '1'

  r.put('/availability', wrap(async (req, res) => {
    const { windows } = parse(availabilityBody, req.body)
    validateWindows(windows)
    const preview = previewFlag(req)
    const moved = applyChange(req.doctor.id, () => {
      db.prepare('DELETE FROM availability WHERE doctor_id = ?').run(req.doctor.id)
      const ins = db.prepare('INSERT INTO availability (doctor_id, weekday, start_time, end_time, slot_minutes) VALUES (?,?,?,?,?)')
      for (const w of windows) ins.run(req.doctor.id, w.weekday, w.start, w.end, w.slotMinutes)
    }, { preview, actorId: req.user.id })
    if (!preview) for (const id of moved) notifier.emit('needs_rebooking', { appointmentId: id, reason: 'Doctor changed availability' })
    res.json({ availability: availabilityRows(req.doctor.id), movedToRebooking: moved.length, preview })
  }))

  // ---- leave ----
  r.post('/leaves', wrap(async (req, res) => {
    const b = parse(leaveBody, req.body)
    if (b.date < istDate(clock().toISOString())) throw new HttpError(400, 'Leave must be today or a future date')
    if (db.prepare('SELECT 1 FROM leaves WHERE doctor_id = ? AND date = ?').get(req.doctor.id, b.date)) throw new HttpError(409, 'You already have leave on that date')
    const preview = previewFlag(req)
    const moved = applyChange(req.doctor.id, () => db.prepare('INSERT INTO leaves (doctor_id, date, reason) VALUES (?,?,?)').run(req.doctor.id, b.date, b.reason), { preview, actorId: req.user.id })
    if (!preview) for (const id of moved) notifier.emit('needs_rebooking', { appointmentId: id, reason: 'Doctor is on leave' })
    res.status(preview ? 200 : 201).json({ leaves: leaveRows(req.doctor.id), movedToRebooking: moved.length, preview })
  }))

  // Removing leave does not bring cancelled slots back; those patients are already being rebooked.
  r.delete('/leaves/:id', wrap(async (req, res) => {
    db.prepare('DELETE FROM leaves WHERE id = ? AND doctor_id = ?').run(Number(req.params.id), req.doctor.id)
    res.json({ leaves: leaveRows(req.doctor.id) })
  }))

  return r
}
