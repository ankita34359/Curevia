import { SESSION_COOKIE, findSessionUser } from './sessions.js'

// Loads req.user from the signed httpOnly session cookie (null when signed out).
export function attachUser(db) {
  return (req, _res, next) => {
    const sid = req.signedCookies?.[SESSION_COOKIE]
    req.sid = sid || null
    req.user = sid ? findSessionUser(db, sid) : null
    next()
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' })
  next()
}

// Every protected API router is mounted behind this, so the check lives on the server.
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' })
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this' })
  next()
}

export function requireVerifiedPatient(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' })
  if (req.user.role !== 'patient') return res.status(403).json({ error: 'Only patients can do this' })
  if (!req.user.emailVerified) return res.status(403).json({ error: 'Please verify your email first', code: 'email_not_verified' })
  next()
}

// Refuses cross-site writes. Browsers send Origin on every POST/PUT/PATCH/DELETE.
export function sameOriginWrites(appUrl) {
  const allowed = new URL(appUrl).host
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    const origin = req.get('origin')
    if (origin) {
      let host = ''
      try { host = new URL(origin).host } catch { /* invalid origin */ }
      if (host !== allowed && host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused' })
    }
    next()
  }
}
