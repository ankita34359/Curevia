import { formatIst, formatIstDate, formatIstTime } from '../lib/time.js'
import { APPT_SELECT } from './appointments.js'
import { deliver } from './deliveries.js'
import { rebookOptions } from './scheduling.js'
import * as t from './emailTemplates.js'

// Turns "something happened to an appointment" into emails, a Google Sheet row and (for the agent) Slack alerts.
// Every send has a unique key per type per appointment, so replays and double ticks never send twice.
export function createNotifications({ db, config, mailer, integrations, clock = () => new Date() }) {
  const load = (id) => {
    const a = db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id)
    if (!a) return null
    const doc = db.prepare('SELECT u.email FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(a.doctor_id)
    return { ...a, doctorEmail: doc?.email, startIst: formatIst(a.start_utc), doctorName: a.doctor_name, patientName: a.patient_name }
  }

  // ---- the Google Sheet row: one per booking and per status change ----
  function sheetRow(a, event) {
    return {
      appointment_id: a.id, patient_name: a.patient_name, age: a.age, gender: a.gender, phone: a.phone, email: a.email, reason: a.reason,
      doctor: a.doctor_name, department: a.department, date: formatIstDate(a.start_utc), time: formatIstTime(a.start_utc),
      status: a.status, event, at: formatIst(clock().toISOString())
    }
  }
  const sendSheet = (a, event) =>
    deliver(db, { channel: 'sheet', type: event, dedupeKey: `sheet:${event}:${a.id}`, appointmentId: a.id, now: clock }, () => integrations.send('appointments_sheet', sheetRow(a, event)))

  const mail = (type, a, to, msg) => mailer.send({ type, dedupeKey: `email:${type}:${a.id}`, appointmentId: a.id, to, subject: msg.subject, html: msg.html })

  const myLink = `${config.appUrl}/my`

  // event: booked | confirmed | cancelled_by_patient | cancelled_by_doctor | needs_rebooking | completed | no_show | rebooked
  async function handle(event, { appointmentId, reason = null } = {}) {
    const a = load(appointmentId)
    if (!a) return
    const jobs = [sendSheet(a, event)]
    if (event === 'booked') {
      // A rebooked appointment that kept its "confirmed" status needs the confirmation, not a new request.
      if (a.status === 'confirmed') jobs.push(mail('patient_confirmed', a, a.email, t.patientConfirmed(a, { link: myLink })))
      else {
        jobs.push(mail('patient_request_received', a, a.email, t.patientRequestReceived(a, { link: myLink })))
        jobs.push(mail('doctor_new_request', a, a.doctorEmail, t.doctorNewRequest(a, { link: `${config.appUrl}/doctor` })))
      }
    } else if (event === 'confirmed') {
      jobs.push(mail('patient_confirmed', a, a.email, t.patientConfirmed(a, { link: myLink })))
    } else if (event === 'cancelled_by_doctor') {
      jobs.push(mail('patient_cancelled', a, a.email, t.patientCancelled(a, { by: 'doctor', reason: reason || a.cancel_reason, link: `${config.appUrl}/doctors` })))
    } else if (event === 'cancelled_by_patient') {
      jobs.push(mail('patient_cancelled', a, a.email, t.patientCancelled(a, { by: 'patient', reason: reason || a.cancel_reason, link: `${config.appUrl}/doctors` })))
      jobs.push(mail('doctor_patient_cancelled', a, a.doctorEmail, t.doctorPatientCancelled(a, { reason: reason || a.cancel_reason, link: `${config.appUrl}/doctor` })))
    } else if (event === 'needs_rebooking') {
      const options = rebookOptions(db, a, clock().toISOString(), { limit: 3 }).map((o) => ({ ...o, startIst: formatIst(o.startUtc) }))
      jobs.push(mail('patient_needs_rebooking', a, a.email, t.patientNeedsRebooking(a, { options, reason: reason || a.cancel_reason, link: `${config.appUrl}/my/rebook/${a.id}` })))
    }
    const results = await Promise.allSettled(jobs)
    for (const r of results) if (r.status === 'rejected') console.error(`Notification for "${event}" failed: ${r.reason?.message}`) // never log appointment data
  }

  // A short alert for the admin in Slack (used by the agent). Same dedupe rule as everything else.
  const slackAlert = ({ dedupeKey, text, appointmentId = null }) =>
    deliver(db, { channel: 'slack', type: 'admin_alert', dedupeKey, appointmentId, now: clock }, () => integrations.send('slack_alert', { text }))

  return { handle, slackAlert, load }
}
