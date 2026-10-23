import { formatIst, formatIstDate, formatIstTime } from '../lib/time.js'
import { APPT_SELECT } from './appointments.js'
import { deliver } from './deliveries.js'
import { rebookOptions } from './scheduling.js'
import * as t from './emailTemplates.js'
import { feedbackLink } from './feedbackToken.js'
import { isQuietNow } from './agent/quiet.js'

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

  // ---- the event emails; each type is built from the appointment's current data, so a failed one can be rebuilt and retried ----
  const myLink = `${config.appUrl}/my`
  const EMAILS = {
    patient_request_received: (a) => ({ to: a.email, msg: t.patientRequestReceived(a, { link: myLink }) }),
    doctor_new_request: (a) => ({ to: a.doctorEmail, msg: t.doctorNewRequest(a, { link: `${config.appUrl}/doctor` }) }),
    patient_confirmed: (a) => ({ to: a.email, msg: t.patientConfirmed(a, { link: myLink }) }),
    patient_cancelled: (a) => ({ to: a.email, msg: t.patientCancelled(a, { by: a.status === 'cancelled_by_doctor' ? 'doctor' : 'patient', reason: a.cancel_reason, link: `${config.appUrl}/doctors` }) }),
    doctor_patient_cancelled: (a) => ({ to: a.doctorEmail, msg: t.doctorPatientCancelled(a, { reason: a.cancel_reason, link: `${config.appUrl}/doctor` }) }),
    patient_feedback_request: (a) => ({ to: a.email, msg: t.patientFeedbackRequest(a, { link: feedbackLink(config.appUrl, config.sessionSecret, a.id) }) }),
    patient_lab_report_ready: (a) => ({ to: a.email, msg: t.patientLabReportReady(a, { note: a.lab_note, link: myLink }) }),
    patient_expired: (a) => ({ to: a.email, msg: t.patientRequestExpired(a, { link: `${config.appUrl}/doctors` }) }),
    patient_needs_rebooking: (a) => {
      const options = rebookOptions(db, a, clock().toISOString(), { limit: 3 }).map((o) => ({ ...o, startIst: formatIst(o.startUtc) }))
      return { to: a.email, msg: t.patientNeedsRebooking(a, { options, reason: a.cancel_reason, link: `${config.appUrl}/my/rebook/${a.id}` }) }
    }
  }
  const mail = (type, a) => {
    const { to, msg } = EMAILS[type](a)
    return mailer.send({ type, dedupeKey: `email:${type}:${a.id}`, appointmentId: a.id, to, subject: msg.subject, html: msg.html })
  }

  // event: booked | confirmed | cancelled_by_patient | cancelled_by_doctor | needs_rebooking | completed | no_show | rebooked | lab_report_ready | feedback_received
  async function handle(event, { appointmentId } = {}) {
    const a = load(appointmentId)
    if (!a) return
    const jobs = [sendSheet(a, event)]
    if (event === 'booked') {
      // A rebooked appointment that kept its "confirmed" status needs the confirmation, not a new request.
      if (a.status === 'confirmed') jobs.push(mail('patient_confirmed', a))
      else jobs.push(mail('patient_request_received', a), mail('doctor_new_request', a))
    } else if (event === 'confirmed') jobs.push(mail('patient_confirmed', a))
    else if (event === 'cancelled_by_doctor') jobs.push(mail('patient_cancelled', a))
    else if (event === 'cancelled_by_patient') jobs.push(mail('patient_cancelled', a), mail('doctor_patient_cancelled', a))
    else if (event === 'needs_rebooking') jobs.push(mail('patient_needs_rebooking', a))
    else if (event === 'lab_report_ready') jobs.push(mail('patient_lab_report_ready', a))
    const results = await Promise.allSettled(jobs)
    for (const r of results) if (r.status === 'rejected') console.error(`Notification for "${event}" failed: ${r.reason?.message}`) // never log appointment data
  }

  // Tries again for sends that failed in the last 24 hours (not ones skipped because an integration is not set up).
  async function retryFailed({ limit = 20, timeUp = () => false } = {}) {
    const rows = db
      .prepare("SELECT * FROM deliveries WHERE status = 'failed' AND attempts < 5 AND appointment_id IS NOT NULL AND channel IN ('email','sheet') AND updated_at >= ? ORDER BY updated_at LIMIT ?")
      .all(new Date(clock().getTime() - 24 * 3600000).toISOString(), limit)
    let retried = 0
    const quiet = config.agent?.quietHours !== false && isQuietNow(clock().toISOString())
    for (const d of rows) {
      if (timeUp()) break
      if (quiet && d.type === 'patient_feedback_request') continue // a "how was your visit?" email is not retried between 10 PM and 8 AM IST
      const a = load(d.appointment_id)
      if (!a) continue
      if (d.channel === 'sheet') await sendSheet(a, d.type)
      else if (EMAILS[d.type]) await mail(d.type, a)
      else continue // reminders and agent emails have their own retry rules
      retried++
    }
    return retried
  }

  // A pending request whose time passed: the sheet row, the patient's email and a Slack alert for the admin.
  // Returns what happened to each, so the agent can write it in its log. Each has its own unique key, so nothing goes out twice.
  async function expired(appointmentId) {
    const a = load(appointmentId)
    if (!a) return null
    const settle = async (p) => { try { const r = await p; return r.status } catch (e) { return `failed: ${String(e?.message).slice(0, 80)}` } }
    const [sheet, email, slack] = await Promise.all([
      settle(sendSheet(a, 'expired')),
      settle(mail('patient_expired', a)),
      settle(slackAlert({ dedupeKey: `slack:request_expired:${a.id}`, appointmentId: a.id, text: `Curevia: the request for appointment #${a.id} with ${a.doctor_name} (${a.department}) on ${a.startIst} IST expired. The doctor never confirmed it. The patient has been asked to book again. Details: ${config.appUrl}/admin/agent` }))
    ])
    return { sheet, email, slack }
  }

  // A short alert for the admin in Slack (used by the agent). Same dedupe rule as everything else.
  const slackAlert = ({ dedupeKey, text, appointmentId = null }) =>
    deliver(db, { channel: 'slack', type: 'admin_alert', dedupeKey, appointmentId, now: clock }, () => integrations.send('slack_alert', { text }))

  return { handle, expired, slackAlert, retryFailed, load, mail }
}
