import { addDays, formatIstDate, formatIstTime, istDate, istTime, istToUtcIso } from '../lib/time.js'
import * as t from './emailTemplates.js'

export const SEND_HOUR_IST = 8
const GIVE_UP_AFTER_TRIES = 5

// "Your appointments for today": ONE email per active doctor per day, listing that day's pending and confirmed appointments.
// It rides on the 5-minute tick: the first tick at or after 8:00 AM IST sends it. Doctors with nothing that day get no email.
// The send has a unique key per doctor per day, stored in the database (deliveries), so it is never sent twice, restarts included.
export function createDailySchedule({ db, config, mailer, clock = () => new Date() }) {
  const keyFor = (doctorId, date) => `email:doctor_daily_schedule:${doctorId}:${date}`

  // Active doctors with at least one pending or confirmed appointment today (India time), each with the list sorted by time.
  function doctorsWithAppointments(nowIso) {
    const today = istDate(nowIso)
    const from = istToUtcIso(today, '00:00')
    const to = istToUtcIso(addDays(today, 1), '00:00')
    const doctors = db.prepare('SELECT d.id, u.name, u.email FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.active = 1 AND u.active = 1 ORDER BY u.name, d.id').all()
    const list = db.prepare("SELECT start_utc, patient_name, age, gender, reason, status FROM appointments WHERE doctor_id = ? AND status IN ('pending','confirmed') AND start_utc >= ? AND start_utc < ? ORDER BY start_utc, id")
    const pendingCount = db.prepare("SELECT COUNT(*) n FROM appointments WHERE doctor_id = ? AND status = 'pending' AND start_utc >= ?")
    const withWork = []
    let withoutAppointments = 0
    for (const d of doctors) {
      const rows = list.all(d.id, from, to)
      if (!rows.length) { withoutAppointments++; continue }
      withWork.push({
        doctor: d,
        items: rows.map((r) => ({ time: formatIstTime(r.start_utc), patientName: r.patient_name, age: r.age, gender: r.gender, reason: r.reason, status: r.status })),
        pendingToday: rows.filter((r) => r.status === 'pending').length,
        pendingTotal: pendingCount.get(d.id, from).n // today's and later requests still waiting for this doctor
      })
    }
    return { today, withWork, withoutAppointments }
  }

  // force = ignore the 8:00 AM gate (the admin's "Send today's schedule now"). Either way the same per-doctor-per-day key applies,
  // so a doctor who already got today's email never gets a second one.
  async function run({ now = clock(), force = false, timeUp = () => false } = {}) {
    const nowIso = now.toISOString()
    const summary = { date: istDate(nowIso), due: true, sent: 0, alreadySent: 0, notSetUp: 0, failed: 0, gaveUp: 0, noAppointments: 0 }
    if (!force && Number(istTime(nowIso).slice(0, 2)) < SEND_HOUR_IST) return { ...summary, due: false }
    const { today, withWork, withoutAppointments } = doctorsWithAppointments(nowIso)
    summary.noAppointments = withoutAppointments
    for (const w of withWork) {
      if (timeUp()) break
      const dedupeKey = keyFor(w.doctor.id, today)
      const before = db.prepare('SELECT status, attempts FROM deliveries WHERE dedupe_key = ?').get(dedupeKey)
      if (before?.status === 'sent') { summary.alreadySent++; continue }
      if (before?.status === 'failed' && before.attempts >= GIVE_UP_AFTER_TRIES && !force) { summary.gaveUp++; continue } // a failing address is not retried all day
      const msg = t.doctorDailySchedule({ doctorName: w.doctor.name, dateText: formatIstDate(nowIso), items: w.items, pendingToday: w.pendingToday, pendingTotal: w.pendingTotal, link: `${config.appUrl}/doctor` })
      const r = await mailer.send({ type: 'doctor_daily_schedule', dedupeKey, to: w.doctor.email, subject: msg.subject, html: msg.html })
      if (r.status === 'sent') r.duplicate ? summary.alreadySent++ : summary.sent++
      else if (r.status === 'skipped') summary.notSetUp++
      else if (r.status === 'failed') summary.failed++
    }
    return summary
  }

  return { run, keyFor }
}
