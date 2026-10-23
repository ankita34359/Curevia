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
  },
  {
    id: 3,
    name: 'integrations',
    sql: `
-- One row per viaSocket embed slot. webhook_url is a credential: it stays on the server.
CREATE TABLE integrations (
  slot TEXT PRIMARY KEY CHECK (slot IN ('appointments_sheet','email_sender','slack_alert')),
  flow_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','drafted','active','paused','deleted')),
  webhook_url TEXT,
  flow_title TEXT,
  updated_at TEXT NOT NULL
);
`
  },
  {
    id: 4,
    name: 'agent',
    sql: `
ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

-- One row per case the agent has looked at. next_check_at lets the agent "wait"; closed_at ends the case.
CREATE TABLE agent_cases (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  case_type TEXT NOT NULL CHECK (case_type IN ('pending','needs_rebooking')),
  next_check_at TEXT,
  closed_at TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (appointment_id, case_type)
);

-- Every decision, with its reason. executed = 1 means the action was carried out (counts toward the limits).
CREATE TABLE agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  case_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai','fallback','guard')),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  params TEXT,
  executed INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  ai_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_agent_log_appt ON agent_log(appointment_id, id);
`
  },
  {
    id: 5,
    name: 'expired_status',
    // A pending request whose time has passed becomes "expired". SQLite cannot change a CHECK, so the appointments table is
    // rebuilt (the documented 12-step way: new table, copy, drop, rename). It must run with foreign keys OFF, otherwise dropping
    // the old table would cascade-delete appointment_events; migrate() switches them off, runs foreign_key_check, and backs the file up first.
    rebuildsTables: true,
    sql: `
CREATE TABLE appointments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','completed','no_show','cancelled_by_patient','cancelled_by_doctor','needs_rebooking','rebooked','expired')),
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
  updated_at TEXT NOT NULL,
  status_before TEXT
);
INSERT INTO appointments_new (id, patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, cancel_reason, rebooked_to_id, confirmed_at, created_at, updated_at, status_before)
  SELECT id, patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, cancel_reason, rebooked_to_id, confirmed_at, created_at, updated_at, status_before FROM appointments;
DROP TABLE appointments;
ALTER TABLE appointments_new RENAME TO appointments;
CREATE INDEX ix_appt_doctor_start ON appointments(doctor_id, start_utc);
CREATE INDEX ix_appt_patient ON appointments(patient_id, start_utc);
CREATE INDEX ix_appt_status ON appointments(status);
CREATE UNIQUE INDEX ux_appt_slot ON appointments(doctor_id, start_utc)
  WHERE status IN ('pending','confirmed','completed','no_show');
`
  },
  {
    id: 6,
    name: 'lab_reports',
    // "Lab report ready" for a completed appointment: only a short note from the doctor, no file and no results.
    // One row per appointment (the primary key), so it can only be marked once. An added table: nothing existing is touched.
    sql: `
CREATE TABLE lab_reports (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id),
  note TEXT NOT NULL DEFAULT '',
  marked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
`
  },
  {
    id: 7,
    name: 'feedback',
    // Patient feedback after a completed visit. Two added tables, nothing existing is touched.
    // feedback.appointment_id is UNIQUE: one feedback per visit, enforced by the database.
    // feedback_requests only exists for visits completed after this release, so old visits never get a retroactive email.
    sql: `
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  category TEXT CHECK (category IS NULL OR category IN ('praise','suggestion','complaint','urgent')),
  category_source TEXT CHECK (category_source IS NULL OR category_source IN ('ai','rule')),
  summary TEXT,
  reason TEXT,
  ai_error TEXT,
  sorted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_feedback_doctor ON feedback(doctor_id, created_at);
CREATE INDEX ix_feedback_created ON feedback(created_at);

-- "How was your visit?" emails waiting for their time (quiet hours hold them until 8 AM IST).
CREATE TABLE feedback_requests (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id),
  send_after TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`
  }
]
