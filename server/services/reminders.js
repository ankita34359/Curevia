import { formatIst } from '../lib/time.js'
import { APPT_SELECT } from './appointments.js'
import * as t from './emailTemplates.js'

const HOUR = 3600000

// 24 h and 1 h reminders, confirmed appointments only. Each is sent at most once (unique key per type per appointment).
// A reminder is only sent if the appointment was confirmed before that mark, so it never repeats the confirmation email.
export async function runReminders({ db, config, mailer, now, timeUp = () => false }) {
  const nowMs = now.getTime()
  const rows = db
    .prepare(`${APPT_SELECT} WHERE a.status = 'confirmed' AND a.start_utc > ? AND a.start_utc <= ? ORDER BY a.start_utc`)
    .all(now.toISOString(), new Date(nowMs + 24 * HOUR).toISOString())
  const out = { considered: rows.length, sent: 0, failed: 0, skipped: 0 }
  for (const a of rows) {
    if (timeUp()) break // the rest is picked up by the next tick
    const startMs = new Date(a.start_utc).getTime()
    const confirmedMs = a.confirmed_at ? new Date(a.confirmed_at).getTime() : startMs
    const hours = startMs - nowMs <= HOUR ? 1 : 24
    if (confirmedMs > startMs - hours * HOUR) continue
    const type = hours === 1 ? 'reminder_1h' : 'reminder_24h'
    const appt = { ...a, startIst: formatIst(a.start_utc), doctorName: a.doctor_name, patientName: a.patient_name }
    const msg = t.patientReminder(appt, { hours, link: `${config.appUrl}/my` })
    const r = await mailer.send({ type, dedupeKey: `email:${type}:${a.id}`, appointmentId: a.id, to: a.email, subject: msg.subject, html: msg.html })
    if (!r.duplicate) out[r.status] = (out[r.status] || 0) + 1
  }
  return out
}
