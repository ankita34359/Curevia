import { z } from 'zod'
import { HttpError } from '../lib/http.js'
import { destroyUserSessions } from '../auth/sessions.js'
import { releaseAllUpcoming } from './appointments.js'

const url = z.string().trim().max(500).refine((v) => v === '' || /^https?:\/\//i.test(v), 'Photo must be an http(s) link')
const languages = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
  .refine((v) => v.length <= 10, 'At most 10 languages')

export const doctorFields = {
  name: z.string().trim().min(2, 'Enter the doctor\'s name').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  departmentId: z.number().int().positive('Choose a department'),
  qualification: z.string().trim().max(200).default(''),
  experienceYears: z.number().int().min(0).max(70).default(0),
  fee: z.number().int().min(0).max(1000000).default(0),
  languages: languages.default([]),
  photoUrl: url.default(''),
  about: z.string().trim().max(600).default('')
}
export const createDoctorSchema = z.object(doctorFields)
export const updateDoctorSchema = z.object(doctorFields).partial()

export const DOCTOR_SELECT = `
  SELECT d.id, d.user_id, u.name, u.email, u.active AS user_active, (u.password_hash IS NOT NULL) AS has_password,
         d.department_id, dep.name AS department, d.qualification, d.experience_years, d.fee, d.languages, d.photo_url, d.about, d.active
  FROM doctors d JOIN users u ON u.id = d.user_id JOIN departments dep ON dep.id = d.department_id`

export const shapeDoctor = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  departmentId: r.department_id,
  department: r.department,
  qualification: r.qualification,
  experienceYears: r.experience_years,
  fee: r.fee,
  languages: r.languages ? r.languages.split(',') : [],
  photoUrl: r.photo_url,
  about: r.about,
  active: !!r.active,
  hasPassword: !!r.has_password
})

export const getDoctor = (db, id) => db.prepare(`${DOCTOR_SELECT} WHERE d.id = ?`).get(id)

function assertDepartment(db, id) {
  if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) throw new HttpError(400, 'That department does not exist')
}

export function createDoctor(db, input, now = new Date()) {
  assertDepartment(db, input.departmentId)
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) throw new HttpError(409, 'Someone already uses that email')
  const t = now.toISOString()
  return db.transaction(() => {
    const u = db.prepare("INSERT INTO users (role, email, name, created_at) VALUES ('doctor', ?, ?, ?)").run(input.email, input.name, t)
    const d = db
      .prepare(
        `INSERT INTO doctors (user_id, department_id, qualification, experience_years, fee, languages, photo_url, about, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(u.lastInsertRowid, input.departmentId, input.qualification, input.experienceYears, input.fee, input.languages.join(','), input.photoUrl, input.about, t)
    return Number(d.lastInsertRowid)
  })()
}

export function updateDoctor(db, id, input) {
  const cur = getDoctor(db, id)
  if (!cur) throw new HttpError(404, 'Doctor not found')
  if (input.departmentId !== undefined) assertDepartment(db, input.departmentId)
  if (input.email !== undefined && input.email !== cur.email.toLowerCase()) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(input.email, cur.user_id)) throw new HttpError(409, 'Someone already uses that email')
  }
  db.transaction(() => {
    if (input.name !== undefined || input.email !== undefined) {
      db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(input.name ?? cur.name, input.email ?? cur.email, cur.user_id)
    }
    const m = (v, old) => (v === undefined ? old : v)
    db.prepare('UPDATE doctors SET department_id=?, qualification=?, experience_years=?, fee=?, languages=?, photo_url=?, about=? WHERE id=?').run(
      m(input.departmentId, cur.department_id),
      m(input.qualification, cur.qualification),
      m(input.experienceYears, cur.experience_years),
      m(input.fee, cur.fee),
      input.languages === undefined ? cur.languages : input.languages.join(','),
      m(input.photoUrl, cur.photo_url),
      m(input.about, cur.about),
      id
    )
  })()
}

// Deactivating signs the doctor out, hides them from booking and puts upcoming appointments into needs_rebooking.
export function deactivateDoctor(db, id, { actorId, now = new Date() }) {
  const cur = getDoctor(db, id)
  if (!cur) throw new HttpError(404, 'Doctor not found')
  return db.transaction(() => {
    db.prepare('UPDATE doctors SET active = 0 WHERE id = ?').run(id)
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(cur.user_id)
    destroyUserSessions(db, cur.user_id)
    return releaseAllUpcoming(db, id, { actorRole: 'admin', actorId, note: 'Doctor deactivated', now })
  })()
}

export function activateDoctor(db, id) {
  const cur = getDoctor(db, id)
  if (!cur) throw new HttpError(404, 'Doctor not found')
  db.prepare('UPDATE doctors SET active = 1 WHERE id = ?').run(id)
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(cur.user_id)
}
