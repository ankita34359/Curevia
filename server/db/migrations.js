// Append-only list. Never edit a migration that has been released; add a new one.
export const migrations = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','doctor','patient')),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  email_verified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('set_password','verify_email')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'stethoscope',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  qualification TEXT NOT NULL DEFAULT '',
  experience_years INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  languages TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Weekly availability in India time. weekday: 0 = Sunday ... 6 = Saturday.
CREATE TABLE availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes BETWEEN 5 AND 120),
  CHECK (end_time > start_time)
);

-- Leave dates are India-time calendar days.
CREATE TABLE leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE (doctor_id, date)
);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','completed','no_show','cancelled_by_patient','cancelled_by_doctor','needs_rebooking','rebooked')),
  patient_name TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  cancel_reason TEXT,
  rebooked_to_id INTEGER REFERENCES appointments(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_appt_doctor_start ON appointments(doctor_id, start_utc);
CREATE INDEX ix_appt_patient ON appointments(patient_id, start_utc);
CREATE INDEX ix_appt_status ON appointments(status);

-- A slot can never be double-booked: only one appointment per doctor and start time may hold it.
-- needs_rebooking / cancelled / rebooked appointments release their slot.
CREATE UNIQUE INDEX ux_appt_slot ON appointments(doctor_id, start_utc)
  WHERE status IN ('pending','confirmed','completed','no_show');

CREATE TABLE appointment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_role TEXT NOT NULL,
  actor_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_events_appt ON appointment_events(appointment_id);

-- Every outgoing email / sheet row / Slack message. dedupe_key makes sending the same thing twice impossible.
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK (channel IN ('email','sheet','slack')),
  type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  appointment_id INTEGER REFERENCES appointments(id),
  recipient TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_deliveries_appt ON deliveries(appointment_id);
`
  },
  {
    id: 2,
    name: 'password_reset_and_rebooking',
    sql: `
-- Remember what an appointment was before it needed rebooking (the new slot keeps that status).
ALTER TABLE appointments ADD COLUMN status_before TEXT;

-- SQLite cannot change a CHECK, so auth_tokens is rebuilt to allow reset_password.
CREATE TABLE auth_tokens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('set_password','verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO auth_tokens_new SELECT * FROM auth_tokens;
DROP TABLE auth_tokens;
ALTER TABLE auth_tokens_new RENAME TO auth_tokens;
`
  }
]
