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
  migrate(db, { file })
  return db
}

// `file` (the database path, not ':memory:') lets a migration that rebuilds a table keep a copy of the file first.
export function migrate(db, { file = null } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id))
  for (const m of migrations) {
    if (done.has(m.id)) continue
    if (m.rebuildsTables) {
      if (file && file !== ':memory:') {
        // Best effort: if the copy cannot be made the migration still runs (it is one transaction and rolls back on any error).
        try {
          db.pragma('wal_checkpoint(TRUNCATE)')
          fs.copyFileSync(file, `${file}.before-migration-${m.id}`)
          console.log(`Database copied to ${path.basename(file)}.before-migration-${m.id} before migration ${m.id} (${m.name}).`)
        } catch (e) { console.warn(`Could not copy the database before migration ${m.id}: ${e.message}`) }
      }
      db.pragma('foreign_keys = OFF') // cannot be changed inside a transaction
    }
    try {
      db.transaction(() => {
        const brokenBefore = m.rebuildsTables ? db.pragma('foreign_key_check').length : 0
        db.exec(m.sql)
        if (m.rebuildsTables) {
          const broken = db.pragma('foreign_key_check').length // only what this migration itself broke counts
          if (broken > brokenBefore) throw new Error(`Migration ${m.id} would break ${broken - brokenBefore} foreign key(s); nothing was changed`)
        }
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString())
      })()
    } finally {
      if (m.rebuildsTables) db.pragma('foreign_keys = ON')
    }
  }
}
