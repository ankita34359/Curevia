import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse, wrap } from '../lib/http.js'
import { toCsv } from '../lib/csv.js'
import { deliver } from '../services/deliveries.js'
import { addDays, formatIst, formatIstDate, formatIstTime, isDateStr, istDate, istToUtcIso } from '../lib/time.js'
import { APPT_SELECT } from '../services/appointments.js'
import { activateDoctor, createDoctor, createDoctorSchema, DOCTOR_SELECT, deactivateDoctor, getDoctor, shapeDoctor, updateDoctorSchema, updateDoctor } from '../services/doctors.js'
import { issueToken, linkFor } from '../services/authTokens.js'
import * as templates from '../services/emailTemplates.js'
import { shapeAppointment } from '../services/shape.js'
import { SLOTS, SLOT_NAMES } from '../integrations/slots.js'
import { formatIst as fmt } from '../lib/time.js'

const deptBody = z.object({
  name: z.string().trim().min(2, 'Enter a department name').max(80),
  description: z.string().trim().max(300).default(''),
  icon: z.string().trim().regex(/^[a-z-]{2,30}$/, 'Pick an icon').default('stethoscope'),
  active: z.boolean().optional()
})

export const APPT_STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled_by_patient', 'cancelled_by_doctor', 'needs_rebooking', 'rebooked']
const listQuery = z.object({
  from: z.string().refine(isDateStr, 'Use YYYY-MM-DD').optional(),
  to: z.string().refine(isDateStr, 'Use YYYY-MM-DD').optional(),
  status: z.enum(APPT_STATUSES).optional(),
  doctorId: z.coerce.number().int().positive().optional()
})

function queryAppointments(db, q, limit = 1000) {
  const where = []
  const args = []
  if (q.from) { where.push('a.start_utc >= ?'); args.push(istToUtcIso(q.from, '00:00')) }
  if (q.to) { where.push('a.start_utc < ?'); args.push(istToUtcIso(addDays(q.to, 1), '00:00')) }
  if (q.status) { where.push('a.status = ?'); args.push(q.status) }
  if (q.doctorId) { where.push('a.doctor_id = ?'); args.push(q.doctorId) }
  return db.prepare(`${APPT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.start_utc DESC LIMIT ${limit}`).all(...args)
}

export function adminRoutes({ config, db, mailer, notifier, clock, viasocket, integrations, tick }) {
  const r = Router()

  // ---- dashboard ----
  r.get(
    '/dashboard',
    wrap(async (_req, res) => {
      const nowIso = clock().toISOString()
      const today = istDate(nowIso)
      const from = istToUtcIso(today, '00:00')
      const to = istToUtcIso(addDays(today, 1), '00:00')
      const one = (sql, ...a) => db.prepare(sql).get(...a).n
      const cards = {
        today: one("SELECT COUNT(*) n FROM appointments WHERE start_utc >= ? AND start_utc < ? AND status IN ('pending','confirmed','completed','no_show')", from, to),
        pending: one("SELECT COUNT(*) n FROM appointments WHERE status = 'pending'"),
        confirmed: one("SELECT COUNT(*) n FROM appointments WHERE status = 'confirmed'"),
        cancelled: one("SELECT COUNT(*) n FROM appointments WHERE status IN ('cancelled_by_patient','cancelled_by_doctor')"),
        needsRebooking: one("SELECT COUNT(*) n FROM appointments WHERE status = 'needs_rebooking'")
      }
      const perDoctor = db
        .prepare(
          `SELECT d.id, u.name, dep.name AS department, d.active,
             COUNT(a.id) AS total,
             COALESCE(SUM(a.status = 'pending'), 0) AS pending,
             COALESCE(SUM(a.status = 'confirmed'), 0) AS confirmed,
             COALESCE(SUM(a.status = 'completed'), 0) AS completed,
             COALESCE(SUM(a.status IN ('cancelled_by_patient','cancelled_by_doctor')), 0) AS cancelled,
             COALESCE(SUM(a.status = 'needs_rebooking'), 0) AS needs_rebooking
           FROM doctors d JOIN users u ON u.id = d.user_id JOIN departments dep ON dep.id = d.department_id
           LEFT JOIN appointments a ON a.doctor_id = d.id
           GROUP BY d.id ORDER BY u.name`
        )
        .all()
        .map((x) => ({ id: x.id, name: x.name, department: x.department, active: !!x.active, total: x.total, pending: x.pending, confirmed: x.confirmed, completed: x.completed, cancelled: x.cancelled, needsRebooking: x.needs_rebooking }))
      res.json({ cards, perDoctor, today })
    })
  )

  // ---- appointments (list + CSV) ----
  r.get('/appointments', (req, res) => {
    const q = parse(listQuery, req.query)
    res.json({ appointments: queryAppointments(db, q, 300).map(shapeAppointment) })
  })

  r.get('/appointments.csv', (req, res) => {
    const q = parse(listQuery, req.query)
    const rows = queryAppointments(db, q, 50000).map((a) => ({
      ...a,
      date: formatIstDate(a.start_utc),
      time: formatIstTime(a.start_utc),
      created: formatIst(a.created_at)
    }))
    const csv = toCsv(rows, [
      { header: 'Appointment ID', key: 'id' }, { header: 'Patient', key: 'patient_name' }, { header: 'Age', key: 'age' },
      { header: 'Gender', key: 'gender' }, { header: 'Phone', key: 'phone' }, { header: 'Email', key: 'email' },
      { header: 'Reason', key: 'reason' }, { header: 'Doctor', key: 'doctor_name' }, { header: 'Department', key: 'department' },
      { header: 'Date (IST)', key: 'date' }, { header: 'Time (IST)', key: 'time' }, { header: 'Status', key: 'status' },
      { header: 'Cancel reason', key: 'cancel_reason' }, { header: 'Booked at (IST)', key: 'created' }
    ])
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="curevia-appointments-${istDate(clock().toISOString())}.csv"`)
    res.send(`﻿${csv}`)
  })

  // ---- departments ----
  const deptRows = () =>
    db
      .prepare(
        `SELECT dep.*, (SELECT COUNT(*) FROM doctors d WHERE d.department_id = dep.id AND d.active = 1) AS doctor_count
         FROM departments dep ORDER BY dep.name COLLATE NOCASE`
      )
      .all()
      .map((d) => ({ id: d.id, name: d.name, description: d.description, icon: d.icon, active: !!d.active, doctorCount: d.doctor_count }))

  r.get('/departments', (_req, res) => res.json({ departments: deptRows() }))

  r.post(
    '/departments',
    wrap(async (req, res) => {
      const b = parse(deptBody, req.body)
      try {
        db.prepare('INSERT INTO departments (name, description, icon, created_at) VALUES (?,?,?,?)').run(b.name, b.description, b.icon, clock().toISOString())
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A department with that name already exists')
        throw e
      }
      res.status(201).json({ departments: deptRows() })
    })
  )

  r.patch(
    '/departments/:id',
    wrap(async (req, res) => {
      const b = parse(deptBody.partial(), req.body)
      const cur = db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(req.params.id))
      if (!cur) throw new HttpError(404, 'Department not found')
      try {
        db.prepare('UPDATE departments SET name = ?, description = ?, icon = ?, active = ? WHERE id = ?').run(
          b.name ?? cur.name, b.description ?? cur.description, b.icon ?? cur.icon, b.active === undefined ? cur.active : b.active ? 1 : 0, cur.id
        )
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A department with that name already exists')
        throw e
      }
      res.json({ departments: deptRows() })
    })
  )

  // ---- doctors ----
  const doctorList = () => db.prepare(`${DOCTOR_SELECT} ORDER BY u.name`).all().map(shapeDoctor)

  // The set-password email. If it could not be sent, the link is returned so the admin can copy it.
  async function inviteDoctor(doctorId) {
    const d = getDoctor(db, doctorId)
    const t = issueToken(db, d.user_id, 'set_password', clock())
    const link = linkFor(config.appUrl, '/set-password', t.token)
    const { subject, html } = templates.doctorSetPassword({ name: d.name, link })
    const sent = await mailer.send({ type: 'doctor_invite', dedupeKey: `doctor_invite:${doctorId}:${t.id}`, to: d.email, subject, html })
    return { emailStatus: sent.status, setPasswordLink: sent.status === 'sent' ? null : link, expiresAt: t.expires.toISOString() }
  }

  r.get('/doctors', (_req, res) => res.json({ doctors: doctorList() }))

  r.post(
    '/doctors',
    wrap(async (req, res) => {
      const input = parse(createDoctorSchema, req.body)
      const id = createDoctor(db, input, clock())
      const invite = await inviteDoctor(id)
      res.status(201).json({ doctor: shapeDoctor(getDoctor(db, id)), ...invite })
    })
  )

  r.patch(
    '/doctors/:id',
    wrap(async (req, res) => {
      updateDoctor(db, Number(req.params.id), parse(updateDoctorSchema, req.body))
      res.json({ doctor: shapeDoctor(getDoctor(db, Number(req.params.id))) })
    })
  )

  r.post(
    '/doctors/:id/invite',
    wrap(async (req, res) => {
      if (!getDoctor(db, Number(req.params.id))) throw new HttpError(404, 'Doctor not found')
      res.json(await inviteDoctor(Number(req.params.id)))
    })
  )

  r.post(
    '/doctors/:id/deactivate',
    wrap(async (req, res) => {
      const moved = deactivateDoctor(db, Number(req.params.id), { actorId: req.user.id, now: clock() })
      for (const id of moved) notifier.emit('needs_rebooking', { appointmentId: id, reason: 'Doctor deactivated' })
      res.json({ doctor: shapeDoctor(getDoctor(db, Number(req.params.id))), movedToRebooking: moved.length })
    })
  )

  r.post(
    '/doctors/:id/activate',
    wrap(async (req, res) => {
      activateDoctor(db, Number(req.params.id))
      res.json({ doctor: shapeDoctor(getDoctor(db, Number(req.params.id))) })
    })
  )

  // ---- agent activity ----
  r.get('/agent', (_req, res) => {
    const now = clock()
    const cases = db
      .prepare(
        `SELECT c.appointment_id, c.case_type, c.next_check_at, c.created_at AS case_created, a.start_utc, du.name AS doctor, dep.name AS department, a.status
         FROM agent_cases c JOIN appointments a ON a.id = c.appointment_id JOIN doctors d ON d.id = a.doctor_id JOIN users du ON du.id = d.user_id JOIN departments dep ON dep.id = d.department_id
         WHERE c.closed_at IS NULL ORDER BY c.created_at`
      )
      .all()
    const open = [
      ...db.prepare("SELECT id, 'pending' AS t FROM appointments WHERE status = 'pending' AND start_utc > ?").all(now.toISOString()),
      ...db.prepare("SELECT id, 'needs_rebooking' AS t FROM appointments WHERE status = 'needs_rebooking'").all()
    ]
    const stats = db.prepare("SELECT appointment_id, case_type, action, COUNT(*) AS n FROM agent_log WHERE executed = 1 GROUP BY appointment_id, case_type, action").all()
    const last = db.prepare('SELECT action, reason, source, executed, outcome, created_at FROM agent_log WHERE appointment_id = ? AND case_type = ? ORDER BY id DESC LIMIT 1')
    const known = new Set(cases.map((c) => `${c.appointment_id}:${c.case_type}`))
    const waiting = open.filter((o) => !known.has(`${o.id}:${o.t}`)).length // stuck bookings the agent has not looked at yet
    const view = cases.map((c) => {
      const n = (a) => stats.find((x) => x.appointment_id === c.appointment_id && x.case_type === c.case_type && x.action === a)?.n || 0
      const l = last.get(c.appointment_id, c.case_type)
      return {
        appointmentId: c.appointment_id, caseType: c.case_type, doctor: c.doctor, department: c.department, status: c.status, whenIst: fmt(c.start_utc),
        openSince: fmt(c.case_created), nextCheckIst: c.next_check_at ? fmt(c.next_check_at) : null,
        done: { doctorReminders: n('remind_doctor'), patientReminders: n('remind_patient'), adminAlerted: n('alert_admin') > 0, offers: n('offer_slots_to_patient') },
        lastDecision: l ? { action: l.action, reason: l.reason, source: l.source, executed: !!l.executed, outcome: l.outcome, atIst: fmt(l.created_at) } : null
      }
    })
    const decisions = db.prepare('SELECT * FROM agent_log ORDER BY id DESC LIMIT 100').all().map((d) => ({
      id: d.id, appointmentId: d.appointment_id, caseType: d.case_type, source: d.source, action: d.action, reason: d.reason, executed: !!d.executed, outcome: d.outcome, aiError: d.ai_error,
      params: d.params ? JSON.parse(d.params) : null, atIst: fmt(d.created_at)
    }))
    res.json({ openCases: view, notLookedAtYet: waiting, decisions, aiConfigured: viasocket.configured })
  })

  // Runs the same job the 5-minute schedule runs.
  r.post('/agent/check-now', wrap(async (_req, res) => {
    res.json({ result: await tick.run() })
  }))

  // ---- viaSocket integrations ----
  r.get('/integrations', wrap(async (req, res) => {
    if (viasocket.configured && req.query.sync === '1') {
      try { await integrations.sync() } catch (e) { console.error(`viaSocket sync failed: ${e.message}`) }
    }
    res.json({ configured: viasocket.configured, missing: viasocket.missing, slots: integrations.states() })
  }))

  // The embed token for the browser (HS256: org_id, project_id, unique_identifier), signed here with the secret.
  r.get('/integrations/embed', wrap(async (_req, res) => {
    if (!viasocket.configured) throw new HttpError(503, `viaSocket is not set up yet. Missing: ${viasocket.missing.join(', ')}`, { missing: viasocket.missing })
    try {
      res.json({ token: await viasocket.embedToken() })
    } catch (e) {
      throw new HttpError(502, 'Could not create the viaSocket embed token')
    }
  }))

  r.post('/integrations/:slot/event', wrap(async (req, res) => {
    const body = parse(z.object({ flowId: z.string().max(100), action: z.enum(['initiated', 'published', 'updated', 'paused', 'deleted']) }), req.body)
    res.json({ slot: await integrations.recordEvent(req.params.slot, body) })
  }))

  r.post('/integrations/:slot/disconnect', wrap(async (req, res) => {
    integrations.disconnect(req.params.slot)
    res.json({ slot: integrations.state(req.params.slot) })
  }))

  // A harmless test message through one slot, so the admin can see it work end to end.
  r.post('/integrations/:slot/test', wrap(async (req, res) => {
    const slot = req.params.slot
    if (!SLOT_NAMES.includes(slot)) throw new HttpError(404, 'Unknown integration slot')
    const at = fmt(clock().toISOString())
    const key = `test:${slot}:${randomUUID()}`
    const def = SLOTS[slot]
    const payloads = {
      appointments_sheet: { ...def.sample, appointment_id: 'TEST', patient_name: 'Test Patient (fake)', phone: '', email: '', event: 'test', status: 'test', at },
      email_sender: { to: req.user.email, subject: 'Curevia test email', body: `<p>This is a test email from Curevia, sent at ${at} (IST). Email sending works.</p>` },
      slack_alert: { text: `Curevia test message (${at} IST). Slack alerts work.` }
    }
    const result = await deliver(db, { channel: def.channel, type: 'test', dedupeKey: key, recipient: slot === 'email_sender' ? req.user.email : null, now: clock }, () => integrations.send(slot, payloads[slot]))
    res.json({ result: result.status, error: result.error || null, slot: integrations.state(slot) })
  }))

  return r
}
