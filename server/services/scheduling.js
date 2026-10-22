import { addDays, istDate, istToUtcIso, minutesToTime, timeToMinutes, weekdayOfDate } from '../lib/time.js'

export const BOOKING_HORIZON_DAYS = 30

// Statuses that hold a slot (same list as the unique index in the database).
export const SLOT_HOLDING = ['pending', 'confirmed', 'completed', 'no_show']

const AVAILABILITY_FOR_DAY = 'SELECT start_time, end_time, slot_minutes FROM availability WHERE doctor_id = ? AND weekday = ? ORDER BY start_time'

export function isOnLeave(db, doctorId, dateStr) {
  return !!db.prepare('SELECT 1 FROM leaves WHERE doctor_id = ? AND date = ?').get(doctorId, dateStr)
}

// Every slot the doctor offers on an India-time calendar day (empty on leave days).
export function daySlots(db, doctorId, dateStr) {
  if (isOnLeave(db, doctorId, dateStr)) return []
  const out = []
  for (const w of db.prepare(AVAILABILITY_FOR_DAY).all(doctorId, weekdayOfDate(dateStr))) {
    const end = timeToMinutes(w.end_time)
    for (let m = timeToMinutes(w.start_time); m + w.slot_minutes <= end; m += w.slot_minutes) {
      const time = minutesToTime(m)
      const endTime = minutesToTime(m + w.slot_minutes)
      out.push({ time, endTime, startUtc: istToUtcIso(dateStr, time), endUtc: istToUtcIso(dateStr, endTime), slotMinutes: w.slot_minutes })
    }
  }
  return out
}

// Slots for a day with their state: free, booked or past.
export function daySlotsWithState(db, doctorId, dateStr, nowIso) {
  const slots = daySlots(db, doctorId, dateStr)
  if (!slots.length) return slots
  const taken = new Set(
    db
      .prepare(`SELECT start_utc FROM appointments WHERE doctor_id = ? AND start_utc >= ? AND start_utc < ? AND status IN (${SLOT_HOLDING.map(() => '?').join(',')})`)
      .all(doctorId, istToUtcIso(dateStr, '00:00'), istToUtcIso(addDays(dateStr, 1), '00:00'), ...SLOT_HOLDING)
      .map((r) => r.start_utc)
  )
  return slots.map((s) => ({ ...s, state: s.startUtc <= nowIso ? 'past' : taken.has(s.startUtc) ? 'booked' : 'free' }))
}

// The first free slot within the horizon, or null.
export function nextAvailable(db, doctorId, nowIso, horizonDays = 30) {
  const today = istDate(nowIso)
  for (let i = 0; i <= horizonDays; i++) {
    const free = daySlotsWithState(db, doctorId, addDays(today, i), nowIso).find((s) => s.state === 'free')
    if (free) return free
  }
  return null
}

// Free slots (up to `limit`) in the next `horizonDays` days.
export function freeSlots(db, doctorId, nowIso, { horizonDays = 14, limit = 50 } = {}) {
  const today = istDate(nowIso)
  const out = []
  for (let i = 0; i <= horizonDays && out.length < limit; i++) {
    for (const s of daySlotsWithState(db, doctorId, addDays(today, i), nowIso)) {
      if (s.state === 'free' && out.length < limit) out.push(s)
    }
  }
  return out
}

// A slot is bookable when the doctor is active, offers exactly this slot, it is in the future and free.
export function findBookableSlot(db, doctorId, startUtc, nowIso) {
  const doc = db.prepare('SELECT d.active, dep.active AS dep_active FROM doctors d JOIN departments dep ON dep.id = d.department_id WHERE d.id = ?').get(doctorId)
  if (!doc || !doc.active || !doc.dep_active) return null
  if (istDate(startUtc) > addDays(istDate(nowIso), BOOKING_HORIZON_DAYS)) return null
  const slot = daySlotsWithState(db, doctorId, istDate(startUtc), nowIso).find((s) => s.startUtc === startUtc)
  return slot && slot.state === 'free' ? slot : null
}

// Does an existing appointment still match what the doctor offers (same start and same length, not on leave)?
export function appointmentFits(db, appt) {
  const doc = db.prepare('SELECT active FROM doctors WHERE id = ?').get(appt.doctor_id)
  if (!doc || !doc.active) return false
  return daySlots(db, appt.doctor_id, istDate(appt.start_utc)).some((s) => s.startUtc === appt.start_utc && s.endUtc === appt.end_utc)
}

// Two appointments of one doctor must never overlap, even if their start times differ.
export function overlapsExisting(db, doctorId, startUtc, endUtc, ignoreId = 0) {
  return !!db
    .prepare(`SELECT 1 FROM appointments WHERE doctor_id = ? AND id != ? AND start_utc < ? AND end_utc > ? AND status IN (${SLOT_HOLDING.map(() => '?').join(',')})`)
    .get(doctorId, ignoreId, endUtc, startUtc, ...SLOT_HOLDING)
}

// Free slots a patient can move to: the same doctor first, then colleagues in the same department.
// Used by the rebooking page, and later by the agent (it may only offer slots from this list).
export function rebookOptions(db, appt, nowIso, { limit = 12, perDoctor = 6, leadMinutes = 0 } = {}) {
  // leadMinutes hides slots that start too soon to be useful (anything earlier counts as already past)
  const fromIso = new Date(new Date(nowIso).getTime() + leadMinutes * 60000).toISOString()
  const dep = db.prepare('SELECT department_id FROM doctors WHERE id = ?').get(appt.doctor_id)?.department_id
  if (!dep) return []
  const doctors = db
    .prepare(
      `SELECT d.id, u.name FROM doctors d JOIN users u ON u.id = d.user_id
       WHERE d.department_id = ? AND d.active = 1 ORDER BY (d.id = ?) DESC, u.name`
    )
    .all(dep, appt.doctor_id)
  const all = []
  for (const d of doctors) {
    for (const s of freeSlots(db, d.id, fromIso, { horizonDays: 14, limit: perDoctor })) {
      all.push({ doctorId: d.id, doctorName: d.name, startUtc: s.startUtc, endUtc: s.endUtc })
    }
  }
  return all.sort((a, b) => a.startUtc.localeCompare(b.startUtc)).slice(0, limit)
}
