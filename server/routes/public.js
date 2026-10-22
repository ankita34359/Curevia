import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse } from '../lib/http.js'
import { addDays, formatIst, formatIstDate, formatIstTime, isDateStr, istDate } from '../lib/time.js'
import { DOCTOR_SELECT, shapeDoctor } from '../services/doctors.js'
import { BOOKING_HORIZON_DAYS, daySlotsWithState, nextAvailable } from '../services/scheduling.js'

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const slotView = (s) => ({ startUtc: s.startUtc, endUtc: s.endUtc, time: s.time, timeIst: formatIstTime(s.startUtc), state: s.state })

// Browsing is open to everyone; only active doctors in active departments are listed.
export function publicRoutes({ db, clock }) {
  const r = Router()
  const listed = `${DOCTOR_SELECT} WHERE d.active = 1 AND dep.active = 1`
  const withNext = (row) => {
    const next = nextAvailable(db, row.id, clock().toISOString(), BOOKING_HORIZON_DAYS)
    return { ...shapeDoctor(row), nextAvailable: next ? { startUtc: next.startUtc, startIst: formatIst(next.startUtc), dateIst: formatIstDate(next.startUtc), timeIst: formatIstTime(next.startUtc) } : null }
  }

  r.get('/departments', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT dep.id, dep.name, dep.description, dep.icon, COUNT(d.id) AS doctor_count
         FROM departments dep LEFT JOIN doctors d ON d.department_id = dep.id AND d.active = 1
         WHERE dep.active = 1 GROUP BY dep.id ORDER BY dep.name COLLATE NOCASE`
      )
      .all()
    res.json({ departments: rows.map((d) => ({ id: d.id, name: d.name, description: d.description, icon: d.icon, doctorCount: d.doctor_count })) })
  })

  r.get('/doctors', (req, res) => {
    const q = parse(z.object({ department: z.coerce.number().int().positive().optional(), q: z.string().trim().max(80).optional(), featured: z.literal('1').optional() }), req.query)
    const where = []
    const args = []
    if (q.department) { where.push('d.department_id = ?'); args.push(q.department) }
    if (q.q) { where.push('(u.name LIKE ? OR dep.name LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`) }
    let rows = db.prepare(`${listed} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY ${q.featured ? 'd.experience_years DESC,' : ''} u.name LIMIT ${q.featured ? 4 : 100}`).all(...args)
    res.json({ doctors: rows.map(withNext) })
  })

  r.get('/doctors/:id', (req, res) => {
    const row = db.prepare(`${listed} AND d.id = ?`).get(Number(req.params.id))
    if (!row) throw new HttpError(404, 'Doctor not found')
    res.json({ doctor: withNext(row) })
  })

  // Seven days of slots starting at `from` (an India-time date). Full and past slots are returned so the UI can disable them.
  r.get('/doctors/:id/slots', (req, res) => {
    const { from } = parse(z.object({ from: z.string().refine(isDateStr, 'Use YYYY-MM-DD').optional() }), req.query)
    const row = db.prepare(`${listed} AND d.id = ?`).get(Number(req.params.id))
    if (!row) throw new HttpError(404, 'Doctor not found')
    const nowIso = clock().toISOString()
    const today = istDate(nowIso)
    const last = addDays(today, BOOKING_HORIZON_DAYS)
    let start = from || today
    if (start < today) start = today
    if (start > last) start = last
    const days = []
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i)
      const slots = date > last ? [] : daySlotsWithState(db, row.id, date, nowIso).map(slotView)
      days.push({ date, weekday: WEEKDAY_SHORT[new Date(`${date}T00:00:00Z`).getUTCDay()], dayOfMonth: Number(date.slice(8)), month: formatIstDate(`${date}T06:00:00Z`).split(' ')[1], freeCount: slots.filter((s) => s.state === 'free').length, slots })
    }
    res.json({ days, from: start, today, canGoBack: start > today, canGoForward: addDays(start, 7) <= last })
  })

  return r
}
