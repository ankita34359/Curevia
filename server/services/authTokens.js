import { newToken, sha256 } from '../lib/tokens.js'

export const TOKEN_TTL_HOURS = { set_password: 48, verify_email: 48, reset_password: 1 }

// Creates a one-time link token. Older unused tokens of the same type for the user are cancelled.
// Returns the raw token (shown once in a link) and its row id.
export function issueToken(db, userId, type, now = new Date()) {
  const { token, hash } = newToken()
  const expires = new Date(now.getTime() + TOKEN_TTL_HOURS[type] * 3600000)
  return db.transaction(() => {
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND type = ? AND used_at IS NULL').run(now.toISOString(), userId, type)
    const info = db
      .prepare('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, type, hash, expires.toISOString(), now.toISOString())
    return { token, id: Number(info.lastInsertRowid), expires }
  })()
}

// Looks a token up without using it. `types` is one type or a list. Returns { id, userId, type } or null if unknown / used / expired.
export function peekToken(db, token, types, now = new Date()) {
  const allowed = [].concat(types)
  if (typeof token !== 'string' || token.length < 20) return null
  const row = db.prepare('SELECT id, user_id, type, expires_at, used_at FROM auth_tokens WHERE token_hash = ?').get(sha256(token))
  if (!row || !allowed.includes(row.type) || row.used_at || row.expires_at <= now.toISOString()) return null
  return { id: row.id, userId: row.user_id, type: row.type }
}

export const consumeToken = (db, id, now = new Date()) =>
  db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now.toISOString(), id).changes === 1

export const linkFor = (appUrl, path, token) => `${appUrl}${path}?token=${encodeURIComponent(token)}`
