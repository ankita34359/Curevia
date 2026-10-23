import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrations } from '../server/db/migrations.js'
import { migrate, openDb } from '../server/db/index.js'

const T = '2026-10-20T10:00:00.000Z'

// A database exactly as it is on Embarko today: migrations 1-4 applied, with data in every table that points at appointments.
function dbAtVersion4(file = ':memory:') {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  for (const m of migrations.filter((x) => x.id <= 4)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)').run(m.id, m.name, T)
  }
  const u = (role, email) => Number(db.prepare("INSERT INTO users (role, email, name, created_at) VALUES (?,?,?,?)").run(role, email, role, T).lastInsertRowid)
  const dep = Number(db.prepare("INSERT INTO departments (name, created_at) VALUES ('General', ?)").run(T).lastInsertRowid)
  const doc = Number(db.prepare('INSERT INTO doctors (user_id, department_id, created_at) VALUES (?,?,?)').run(u('doctor', 'd@x.test'), dep, T).lastInsertRowid)
  const pat = u('patient', 'p@x.test')
  const appt = (start, status, extra = {}) => Number(db.prepare(
    `INSERT INTO appointments (patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, cancel_reason, rebooked_to_id, confirmed_at, created_at, updated_at, status_before)
     VALUES (?,?,?,?,?,'Pat',30,'female','900','p@x.test','Fake',?,?,?,?,?,?)`
  ).run(pat, doc, start, start, status, extra.cancel ?? null, extra.rebookedTo ?? null, extra.confirmedAt ?? null, T, T, extra.before ?? null).lastInsertRowid)
  const a2 = appt('2026-10-26T04:00:00.000Z', 'pending')
  const a1 = appt('2026-10-25T04:00:00.000Z', 'rebooked', { rebookedTo: a2, cancel: 'Doctor on leave', before: 'confirmed', confirmedAt: T })
  appt('2026-10-27T04:00:00.000Z', 'confirmed', { confirmedAt: T })
  db.prepare("INSERT INTO appointment_events (appointment_id, event, from_status, to_status, actor_role, created_at) VALUES (?, 'booked', NULL, 'pending', 'patient', ?)").run(a1, T)
  db.prepare("INSERT INTO appointment_events (appointment_id, event, from_status, to_status, actor_role, created_at) VALUES (?, 'booked', NULL, 'pending', 'patient', ?)").run(a2, T)
  db.prepare("INSERT INTO deliveries (channel, type, dedupe_key, appointment_id, status, created_at, updated_at) VALUES ('email','x','k1',?, 'sent', ?, ?)").run(a1, T, T)
  db.prepare("INSERT INTO agent_cases (appointment_id, case_type, created_at) VALUES (?, 'pending', ?)").run(a2, T)
  db.prepare("INSERT INTO agent_log (appointment_id, case_type, source, action, reason, executed, outcome, created_at) VALUES (?, 'pending', 'ai', 'wait', 'r', 1, 'o', ?)").run(a2, T)
  return { db, ids: { a1, a2, doc, pat } }
}

const dump = (db) => ({
  appointments: db.prepare('SELECT * FROM appointments ORDER BY id').all(),
  events: db.prepare('SELECT * FROM appointment_events ORDER BY id').all(),
  deliveries: db.prepare('SELECT * FROM deliveries ORDER BY id').all(),
  cases: db.prepare('SELECT * FROM agent_cases').all(),
  log: db.prepare('SELECT * FROM agent_log ORDER BY id').all()
})

describe('migration 5: the "expired" status', () => {
  it('keeps every row of every table (the old table is dropped without cascading), and rows pointing at appointments still point at them', () => {
    const { db, ids } = dbAtVersion4()
    const before = dump(db)
    migrate(db)
    expect(dump(db)).toEqual(before) // appointments (all 18 columns, incl. status_before and rebooked_to_id), events, deliveries, agent tables
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1) // switched back on
    expect(db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get().v).toBe(migrations.length) // 5 added "expired", later ones only add tables
    // the self-reference (rebooked_to_id) and the other tables' references are live again
    expect(() => db.prepare('UPDATE appointments SET rebooked_to_id = 9999 WHERE id = ?').run(ids.a1)).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare("INSERT INTO appointment_events (appointment_id, event, actor_role, created_at) VALUES (9999, 'x', 'system', ?)").run(T)).toThrow(/FOREIGN KEY/)
    expect(() => db.prepare('DELETE FROM appointments WHERE id = ?').run(ids.a1)).toThrow(/FOREIGN KEY/) // its email delivery still points at it
    db.prepare('DELETE FROM deliveries WHERE appointment_id = ?').run(ids.a1)
    db.prepare('DELETE FROM appointments WHERE id = ?').run(ids.a1)
    expect(db.prepare('SELECT COUNT(*) n FROM appointment_events WHERE appointment_id = ?').get(ids.a1).n).toBe(0) // ON DELETE CASCADE still there
  })

  it('accepts "expired", still rejects other statuses, and keeps the indexes (no double booking)', () => {
    const { db, ids } = dbAtVersion4()
    migrate(db)
    expect(() => db.prepare("UPDATE appointments SET status = 'expired' WHERE id = ?").run(ids.a2)).not.toThrow()
    expect(() => db.prepare("UPDATE appointments SET status = 'bogus' WHERE id = ?").run(ids.a2)).toThrow(/CHECK/)
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'appointments'").all().map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['ix_appt_doctor_start', 'ix_appt_patient', 'ix_appt_status', 'ux_appt_slot']))
    // the confirmed appointment holds its slot: a second one at the same time is refused
    const taken = db.prepare("SELECT doctor_id, start_utc FROM appointments WHERE status = 'confirmed'").get()
    const dup = () => db.prepare(`INSERT INTO appointments (patient_id, doctor_id, start_utc, end_utc, status, patient_name, age, gender, phone, email, reason, created_at, updated_at) VALUES (?,?,?,?, 'pending','P',1,'x','1','e','r',?,?)`).run(ids.pat, taken.doctor_id, taken.start_utc, taken.start_utc, T, T)
    expect(dup).toThrow(/UNIQUE/)
    // an expired request releases its slot
    db.prepare("UPDATE appointments SET status = 'expired' WHERE status = 'confirmed'").run()
    expect(dup).not.toThrow()
  })

  it('is applied once, and a new database gets the same result', () => {
    const fresh = new Database(':memory:')
    fresh.pragma('foreign_keys = ON')
    migrate(fresh)
    migrate(fresh)
    expect(fresh.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n).toBe(migrations.length)
    expect(fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'appointments'").get().sql).toMatch(/'expired'/)
  })

  it('an old stray row that already breaks a foreign key does not stop the app from starting', () => {
    const { db } = dbAtVersion4()
    db.pragma('foreign_keys = OFF')
    db.prepare("INSERT INTO appointment_events (appointment_id, event, actor_role, created_at) VALUES (4242, 'orphan', 'system', ?)").run(T)
    db.pragma('foreign_keys = ON')
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare("SELECT COUNT(*) n FROM appointment_events WHERE event = 'orphan'").get().n).toBe(1)
  })

  describe('on a real file', () => {
    const dirs = []
    afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

    it('copies the database file first, and the copy is the old version', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curevia-mig-'))
      dirs.push(dir)
      const file = path.join(dir, 'curevia.db')
      const { db, ids } = dbAtVersion4(file)
      db.close()
      const live = openDb(file)
      expect(live.prepare('SELECT MAX(id) v FROM schema_migrations').get().v).toBe(migrations.length)
      expect(live.prepare('SELECT COUNT(*) n FROM appointments').get().n).toBe(3)
      const copy = new Database(`${file}.before-migration-5`, { readonly: true })
      expect(copy.prepare('SELECT MAX(id) v FROM schema_migrations').get().v).toBe(4)
      expect(copy.prepare('SELECT COUNT(*) n FROM appointments').get().n).toBe(3)
      copy.close()
      expect(ids.a1).toBeGreaterThan(0)
      live.close()
      // opening again does nothing more and makes no second copy
      fs.rmSync(`${file}.before-migration-5`)
      openDb(file).close()
      expect(fs.existsSync(`${file}.before-migration-5`)).toBe(false)
    })
  })
})
