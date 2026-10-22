import { hashPassword, verifyPassword } from '../auth/passwords.js'

// The single admin account always matches ADMIN_EMAIL / ADMIN_PASSWORD.
export async function ensureAdmin(db, config, now = new Date()) {
  const existing = db.prepare("SELECT id, email, password_hash FROM users WHERE role = 'admin'").get()
  if (!existing) {
    const clash = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail)
    if (clash) throw new Error('ADMIN_EMAIL is already used by another account')
    const hash = await hashPassword(config.adminPassword, config.bcryptCost)
    db.prepare(
      "INSERT INTO users (role, email, name, password_hash, email_verified_at, created_at) VALUES ('admin', ?, 'Administrator', ?, ?, ?)"
    ).run(config.adminEmail, hash, now.toISOString(), now.toISOString())
    return
  }
  const sameEmail = existing.email.toLowerCase() === config.adminEmail
  const samePassword = existing.password_hash && (await verifyPassword(config.adminPassword, existing.password_hash))
  if (sameEmail && samePassword) return
  if (!sameEmail) {
    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(config.adminEmail, existing.id)
    if (clash) throw new Error('ADMIN_EMAIL is already used by another account')
  }
  const hash = samePassword ? existing.password_hash : await hashPassword(config.adminPassword, config.bcryptCost)
  db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(config.adminEmail, hash, existing.id)
  if (!samePassword || !sameEmail) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id)
}
