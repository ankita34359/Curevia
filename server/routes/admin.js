import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse, wrap } from '../lib/http.js'
import { toCsv } from '../lib/csv.js'
import { addDays, formatIst, formatIstDate, formatIstTime, isDateStr, istDate, istToUtcIso } from '../lib/time.js'
import { APPT_SELECT } from '../services/appointments.js'
import { activateDoctor, createDoctor, createDoctorSchema, DOCTOR_SELECT, deactivateDoctor, getDoctor, shapeDoctor, updateDoctorSchema, updateDoctor } from '../services/doctors.js'
import { issueToken, linkFor } from '../services/authTokens.js'
import * as templates from '../services/emailTemplates.js'
import { shapeAppointment } from '../services/shape.js'

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

export function adminRoutes({ config, db, mailer, notifier, clock }) {
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

  return r
}
