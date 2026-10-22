import { newToken, sha256 } from '../lib/tokens.js'

export const SESSION_COOKIE = 'curevia_sid'
export const SESSION_DAYS = 7

export function createSession(db, userId, now = new Date()) {
  const { token, hash } = newToken()
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000)
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash, userId, now.toISOString(), expires.toISOString())
  return { sid: token, expires }
}

// Returns the user for a session id, or null when it is unknown, expired, or the user is inactive.
export function findSessionUser(db, sid, now = new Date()) {
  if (!sid) return null
  const row = db
    .prepare(
      `SELECT u.id, u.role, u.email, u.name, u.email_verified_at, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(sha256(sid))
  if (!row) return null
  if (row.expires_at <= now.toISOString() || !row.active) {
    destroySession(db, sid)
    return null
  }
  return { id: row.id, role: row.role, email: row.email, name: row.name, emailVerified: !!row.email_verified_at }
}

export const destroySession = (db, sid) => db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid))
export const destroyUserSessions = (db, userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
export const purgeExpiredSessions = (db, now = new Date()) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString())
