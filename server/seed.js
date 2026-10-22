import { hashPassword } from './auth/passwords.js'

// FAKE DATA for local testing only: 6 departments, 2 doctors in each (all with availability), 1 patient.
export const DEMO_PASSWORD = 'demo-pass-123'

export const DEMO_DEPARTMENTS = [
  ['General Medicine', 'Everyday health concerns, check-ups and follow-ups.', 'stethoscope'],
  ['Pediatrics', 'Care for babies, children and teenagers.', 'baby'],
  ['Cardiology', 'Heart and blood-pressure care.', 'heart'],
  ['Orthopedics', 'Bones, joints and muscles.', 'bone'],
  ['Dermatology', 'Skin, hair and nail care.', 'skin'],
  ['ENT', 'Ear, nose and throat care.', 'ear']
]

// windows: [weekday 0-6 (0 = Sunday), start, end] in India time
const WEEKDAYS_AM = (s, e) => [1, 2, 3, 4, 5].map((d) => [d, s, e])
const DEMO_DOCTORS = [
  { name: 'Dr. Anita Rao', email: 'anita.rao@example.com', dept: 'General Medicine', q: 'MBBS, MD (Internal Medicine)', exp: 14, fee: 600, langs: 'English,Hindi,Kannada', slot: 15, windows: [...WEEKDAYS_AM('09:00', '13:00'), [1, '16:00', '19:00'], [3, '16:00', '19:00']] },
  { name: 'Dr. Vikram Shah', email: 'vikram.shah@example.com', dept: 'General Medicine', q: 'MBBS, DNB', exp: 8, fee: 450, langs: 'English,Hindi,Gujarati', slot: 20, windows: [[1, '10:00', '14:00'], [2, '10:00', '14:00'], [4, '10:00', '14:00'], [5, '10:00', '14:00'], [6, '09:00', '12:00']] },
  { name: 'Dr. Meera Iyer', email: 'meera.iyer@example.com', dept: 'Pediatrics', q: 'MBBS, MD (Pediatrics)', exp: 11, fee: 700, langs: 'English,Hindi,Tamil', slot: 30, windows: [[1, '09:30', '13:30'], [2, '09:30', '13:30'], [3, '09:30', '13:30'], [4, '15:00', '18:00'], [5, '15:00', '18:00'], [6, '09:30', '12:30']] },
  { name: 'Dr. Arjun Nair', email: 'arjun.nair@example.com', dept: 'Pediatrics', q: 'MBBS, DCH', exp: 6, fee: 550, langs: 'English,Malayalam,Hindi', slot: 20, windows: [[1, '14:00', '18:00'], [2, '14:00', '18:00'], [3, '14:00', '18:00'], [5, '10:00', '13:00'], [6, '10:00', '13:00']] },
  { name: 'Dr. Kavita Menon', email: 'kavita.menon@example.com', dept: 'Cardiology', q: 'MBBS, MD, DM (Cardiology)', exp: 18, fee: 1200, langs: 'English,Hindi,Malayalam', slot: 30, windows: [[1, '09:00', '12:00'], [3, '09:00', '12:00'], [4, '09:00', '12:00'], [5, '15:00', '18:00']] },
  { name: 'Dr. Rohan Kapoor', email: 'rohan.kapoor@example.com', dept: 'Cardiology', q: 'MBBS, DNB (Cardiology)', exp: 9, fee: 900, langs: 'English,Hindi,Punjabi', slot: 30, windows: [[2, '10:00', '13:00'], [4, '14:00', '18:00'], [6, '09:00', '13:00']] },
  { name: 'Dr. Sanjay Patil', email: 'sanjay.patil@example.com', dept: 'Orthopedics', q: 'MBBS, MS (Orthopedics)', exp: 15, fee: 800, langs: 'English,Hindi,Marathi', slot: 15, windows: [[1, '16:00', '19:00'], [2, '16:00', '19:00'], [4, '09:00', '12:00'], [5, '09:00', '12:00']] },
  { name: 'Dr. Neha Joshi', email: 'neha.joshi@example.com', dept: 'Orthopedics', q: 'MBBS, DNB (Orthopedics)', exp: 7, fee: 650, langs: 'English,Hindi,Marathi', slot: 20, windows: [[1, '09:00', '13:00'], [3, '09:00', '13:00'], [6, '10:00', '14:00']] },
  { name: 'Dr. Pooja Desai', email: 'pooja.desai@example.com', dept: 'Dermatology', q: 'MBBS, MD (Dermatology)', exp: 10, fee: 750, langs: 'English,Hindi,Gujarati', slot: 15, windows: [[1, '11:00', '15:00'], [2, '11:00', '15:00'], [3, '11:00', '15:00'], [5, '11:00', '14:00']] },
  { name: 'Dr. Imran Qureshi', email: 'imran.qureshi@example.com', dept: 'Dermatology', q: 'MBBS, DDVL', exp: 5, fee: 500, langs: 'English,Hindi,Urdu', slot: 15, windows: [[2, '16:00', '19:00'], [4, '16:00', '19:00'], [6, '09:00', '13:00']] },
  { name: 'Dr. Lakshmi Reddy', email: 'lakshmi.reddy@example.com', dept: 'ENT', q: 'MBBS, MS (ENT)', exp: 13, fee: 700, langs: 'English,Telugu,Hindi', slot: 20, windows: [[1, '10:00', '13:00'], [3, '10:00', '13:00'], [5, '10:00', '13:00'], [4, '16:00', '19:00']] },
  { name: 'Dr. Amit Banerjee', email: 'amit.banerjee@example.com', dept: 'ENT', q: 'MBBS, DLO', exp: 7, fee: 550, langs: 'English,Bengali,Hindi', slot: 20, windows: [[2, '09:30', '13:30'], [4, '09:30', '13:30'], [6, '10:00', '13:00']] }
]

export async function seedDemo(db, { cost = 10, now = new Date() } = {}) {
  const t = now.toISOString()
  const hash = await hashPassword(DEMO_PASSWORD, cost)
  const dept = db.prepare('INSERT OR IGNORE INTO departments (name, description, icon, created_at) VALUES (?,?,?,?)')
  for (const [name, description, icon] of DEMO_DEPARTMENTS) dept.run(name, description, icon, t)
  const depId = (n) => db.prepare('SELECT id FROM departments WHERE name = ?').get(n).id

  for (const d of DEMO_DOCTORS) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(d.email)) continue
    const u = db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('doctor',?,?,?,?,?)").run(d.email, d.name, hash, t, t)
    const about = `Fake demo profile. ${d.name.replace('Dr. ', 'Dr. ')} sees patients in ${d.dept} and takes the time to explain things clearly.`
    const doc = db
      .prepare('INSERT INTO doctors (user_id, department_id, qualification, experience_years, fee, languages, about, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(u.lastInsertRowid, depId(d.dept), d.q, d.exp, d.fee, d.langs, about, t)
    for (const [wd, s, e] of d.windows) db.prepare('INSERT INTO availability (doctor_id, weekday, start_time, end_time, slot_minutes) VALUES (?,?,?,?,?)').run(doc.lastInsertRowid, wd, s, e, d.slot)
  }
  if (!db.prepare("SELECT 1 FROM users WHERE email = 'patient@example.com'").get()) {
    db.prepare("INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('patient','patient@example.com','Demo Patient',?,?,?)").run(hash, t, t)
  }
}
