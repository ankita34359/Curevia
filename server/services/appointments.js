import { HttpError } from '../lib/http.js'
import { appointmentFits } from './scheduling.js'

export const TRANSITIONS = {
  pending: ['confirmed', 'cancelled_by_patient', 'cancelled_by_doctor', 'needs_rebooking', 'rebooked'],
  confirmed: ['completed', 'no_show', 'cancelled_by_patient', 'cancelled_by_doctor', 'needs_rebooking'],
  needs_rebooking: ['rebooked', 'cancelled_by_patient'],
  completed: [],
  no_show: [],
  cancelled_by_patient: [],
  cancelled_by_doctor: [],
  rebooked: []
}
export const OPEN_FOR_DOCTOR = ['pending', 'confirmed']

export const getAppointment = (db, id) => db.prepare('SELECT * FROM appointments WHERE id = ?').get(id)

export function logEvent(db, appointmentId, event, { from = null, to = null, actorRole, actorId = null, note = null, now = new Date() }) {
  db.prepare('INSERT INTO appointment_events (appointment_id, event, from_status, to_status, actor_role, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    appointmentId, event, from, to, actorRole, actorId, note, now.toISOString()
  )
}

// The one place where an appointment's status changes. Throws 409 for a move the status flow does not allow.
export function changeStatus(db, id, to, { actorRole, actorId = null, note = null, cancelReason = null, now = new Date() }) {
  const appt = getAppointment(db, id)
  if (!appt) throw new HttpError(404, 'Appointment not found')
  if (!TRANSITIONS[appt.status]?.includes(to)) throw new HttpError(409, `An appointment that is ${appt.status.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`)
  const t = now.toISOString()
  db.prepare(
    `UPDATE appointments SET status = ?, updated_at = ?, cancel_reason = COALESCE(?, cancel_reason),
       status_before = CASE WHEN ? = 'needs_rebooking' THEN ? ELSE status_before END,
       confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END
     WHERE id = ?`
  ).run(to, t, cancelReason, to, appt.status, to, t, id)
  logEvent(db, id, to, { from: appt.status, to, actorRole, actorId, note, now })
  return { before: appt, after: getAppointment(db, id) }
}

// Moves every future pending/confirmed appointment of a doctor that no longer fits to needs_rebooking.
export function revalidateDoctor(db, doctorId, { actorRole, actorId = null, note, now = new Date() }) {
  const nowIso = now.toISOString()
  const open = db.prepare("SELECT * FROM appointments WHERE doctor_id = ? AND status IN ('pending','confirmed') AND start_utc > ?").all(doctorId, nowIso)
  const moved = []
  db.transaction(() => {
    for (const a of open) {
      if (appointmentFits(db, a)) continue
      changeStatus(db, a.id, 'needs_rebooking', { actorRole, actorId, note, now })
      moved.push(a.id)
    }
  })()
  return moved
}

// Every future pending/confirmed appointment of a doctor goes to needs_rebooking (deactivation).
export function releaseAllUpcoming(db, doctorId, { actorRole, actorId = null, note, now = new Date() }) {
  const open = db.prepare("SELECT id FROM appointments WHERE doctor_id = ? AND status IN ('pending','confirmed') AND start_utc > ?").all(doctorId, now.toISOString())
  db.transaction(() => {
    for (const a of open) changeStatus(db, a.id, 'needs_rebooking', { actorRole, actorId, note, now })
  })()
  return open.map((a) => a.id)
}

// Appointment joined with doctor / department names, the shape used by lists and emails.
export const APPT_SELECT = `
  SELECT a.*, du.name AS doctor_name, dep.name AS department, dep.id AS department_id
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  JOIN departments dep ON dep.id = d.department_id`
