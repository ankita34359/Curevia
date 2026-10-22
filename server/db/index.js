import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrations } from './migrations.js'

// file === ':memory:' is used by the tests.
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id))
  for (const m of migrations) {
    if (done.has(m.id)) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString())
    })()
  }
}
