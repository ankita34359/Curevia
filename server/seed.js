import { hashPassword } from './auth/passwords.js'

// FAKE DATA for local testing only: 2 departments, 3 doctors with availability, 1 patient.
export const DEMO_PASSWORD = 'demo-pass-123'

export async function seedDemo(db, { cost = 10, now = new Date() } = {}) {
  const t = now.toISOString()
  const hash = await hashPassword(DEMO_PASSWORD, cost)
  const dept = db.prepare('INSERT OR IGNORE INTO departments (name, description, icon, created_at) VALUES (?,?,?,?)')
  dept.run('General Medicine', 'Everyday health concerns, check-ups and follow-ups.', 'stethoscope', t)
  dept.run('Pediatrics', 'Care for babies, children and teenagers.', 'baby', t)
  const depId = (n) => db.prepare('SELECT id FROM departments WHERE name = ?').get(n).id

  const doctors = [
    { name: 'Dr. Anita Rao', email: 'anita.rao@example.com', dept: 'General Medicine', q: 'MBBS, MD (Internal Medicine)', exp: 14, fee: 600, langs: 'English,Hindi,Kannada', about: 'Fake demo profile. Focuses on preventive care and long-term conditions.', slot: 15, windows: [[1, '09:00', '13:00'], [2, '09:00', '13:00'], [3, '09:00', '13:00'], [4, '09:00', '13:00'], [5, '09:00', '13:00'], [1, '16:00', '19:00'], [3, '16:00', '19:00']] },
    { name: 'Dr. Vikram Shah', email: 'vikram.shah@example.com', dept: 'General Medicine', q: 'MBBS, DNB', exp: 8, fee: 450, langs: 'English,Hindi,Gujarati', about: 'Fake demo profile. Family physician with a calm, thorough style.', slot: 20, windows: [[1, '10:00', '14:00'], [2, '10:00', '14:00'], [4, '10:00', '14:00'], [5, '10:00', '14:00'], [6, '09:00', '12:00']] },
    { name: 'Dr. Meera Iyer', email: 'meera.iyer@example.com', dept: 'Pediatrics', q: 'MBBS, MD (Pediatrics)', exp: 11, fee: 700, langs: 'English,Hindi,Tamil', about: 'Fake demo profile. Loves putting young patients and parents at ease.', slot: 30, windows: [[1, '09:30', '13:30'], [2, '09:30', '13:30'], [3, '09:30', '13:30'], [4, '15:00', '18:00'], [5, '15:00', '18:00'], [6, '09:30', '12:30']] }
  ]
  for (const d of doctors) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(d.email)) continue
    const u = db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('doctor',?,?,?,?,?)").run(d.email, d.name, hash, t, t)
    const doc = db
      .prepare('INSERT INTO doctors (user_id, department_id, qualification, experience_years, fee, languages, about, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(u.lastInsertRowid, depId(d.dept), d.q, d.exp, d.fee, d.langs, d.about, t)
    for (const [wd, s, e] of d.windows) db.prepare('INSERT INTO availability (doctor_id, weekday, start_time, end_time, slot_minutes) VALUES (?,?,?,?,?)').run(doc.lastInsertRowid, wd, s, e, d.slot)
  }
  if (!db.prepare("SELECT 1 FROM users WHERE email = 'patient@example.com'").get()) {
    db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('patient','patient@example.com','Demo Patient',?,?,?)").run(hash, t, t)
  }
}
