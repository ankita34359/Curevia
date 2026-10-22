import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { z } from 'zod'
import { HttpError, parse, wrap } from '../lib/http.js'
import { hashPassword, passwordProblem, verifyPassword } from '../auth/passwords.js'
import { SESSION_COOKIE, createSession, destroySession, destroyUserSessions } from '../auth/sessions.js'
import { requireAuth } from '../auth/middleware.js'
import { consumeToken, issueToken, linkFor, peekToken } from '../services/authTokens.js'
import * as templates from '../services/emailTemplates.js'

const emailField = z.string().trim().toLowerCase().email('Enter a valid email').max(200)
const loginBody = z.object({ email: emailField, password: z.string().min(1).max(200) })
const signupBody = z.object({ name: z.string().trim().min(2, 'Enter your name').max(100), email: emailField, password: z.string().max(200) })
const tokenBody = z.object({ token: z.string().min(10).max(200) })
const forgotBody = z.object({ email: emailField })
const setPasswordBody = tokenBody.extend({ password: z.string().max(200) })

export function authRoutes({ config, db, mailer }) {
  const r = Router()
  const secure = config.appUrl.startsWith('https://')
  // Compared against when the email is unknown, so response time does not reveal which emails exist.
  const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptCost)

  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' })
  })
  const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many sign-ups from this network. Please try later.' })
  })

  const forgotLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
    handler: (_req, res) => res.status(429).json({ error: 'Too many reset requests. Please try again in an hour.' })
  })

  function startSession(res, userId) {
    const { sid, expires } = createSession(db, userId)
    res.cookie(SESSION_COOKIE, sid, { httpOnly: true, signed: true, sameSite: 'lax', secure, expires, path: '/' })
  }
  const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, email: u.email, emailVerified: u.emailVerified })

  r.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }))

  r.post(
    '/login',
    loginLimiter,
    wrap(async (req, res) => {
      const { email, password } = parse(loginBody, req.body)
      const user = db.prepare('SELECT id, role, email, name, password_hash, email_verified_at, active FROM users WHERE email = ?').get(email)
      const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH)
      if (!user || !user.password_hash || !ok || !user.active) throw new HttpError(401, 'Invalid email or password')
      startSession(res, user.id)
      res.json({ user: publicUser({ ...user, emailVerified: !!user.email_verified_at }) })
    })
  )

  r.post('/logout', (req, res) => {
    if (req.sid) destroySession(db, req.sid)
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.json({ ok: true })
  })

  r.post(
    '/signup',
    signupLimiter,
    wrap(async (req, res) => {
      const body = parse(signupBody, req.body)
      const problem = passwordProblem(body.password)
      if (problem) throw new HttpError(400, problem)
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) throw new HttpError(409, 'An account with this email already exists. Try signing in.')
      const hash = await hashPassword(body.password, config.bcryptCost)
      const info = db
        .prepare("INSERT INTO users (role, email, name, password_hash, created_at) VALUES ('patient', ?, ?, ?, ?)")
        .run(body.email, body.name, hash, new Date().toISOString())
      const userId = Number(info.lastInsertRowid)
      await sendVerification(userId, body.email, body.name)
      startSession(res, userId)
      res.status(201).json({ user: { id: userId, role: 'patient', name: body.name, email: body.email, emailVerified: false } })
    })
  )

  async function sendVerification(userId, email, name) {
    const t = issueToken(db, userId, 'verify_email')
    const { subject, html } = templates.verifyEmail({ name, link: linkFor(config.appUrl, '/verify-email', t.token) })
    return mailer.send({ type: 'verify_email', dedupeKey: `verify_email:${userId}:${t.id}`, to: email, subject, html })
  }

  r.post(
    '/resend-verification',
    requireAuth,
    wrap(async (req, res) => {
      if (req.user.role !== 'patient') throw new HttpError(403, 'Only patients need to verify their email')
      if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true })
      const result = await sendVerification(req.user.id, req.user.email, req.user.name)
      res.json({ ok: true, emailStatus: result.status })
    })
  )

  r.post(
    '/verify-email',
    wrap(async (req, res) => {
      const { token } = parse(tokenBody, req.body)
      const t = peekToken(db, token, 'verify_email')
      if (!t) throw new HttpError(400, 'This link is invalid or has expired. Request a new one after signing in.')
      db.transaction(() => {
        consumeToken(db, t.id)
        db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(new Date().toISOString(), t.userId)
      })()
      res.json({ ok: true })
    })
  )

  // Always answers the same, so it cannot be used to find out which emails have accounts. Admin uses ADMIN_PASSWORD.
  r.post(
    '/forgot-password',
    forgotLimiter,
    wrap(async (req, res) => {
      const { email } = parse(forgotBody, req.body)
      const user = db.prepare("SELECT id, name, email FROM users WHERE email = ? AND active = 1 AND role != 'admin'").get(email)
      if (user) {
        const t = issueToken(db, user.id, 'reset_password')
        const { subject, html } = templates.resetPassword({ name: user.name, link: linkFor(config.appUrl, '/reset-password', t.token) })
        await mailer.send({ type: 'reset_password', dedupeKey: `reset_password:${user.id}:${t.id}`, to: user.email, subject, html })
      }
      res.json({ ok: true })
    })
  )

  // Lets the "set your password" page greet the doctor before they type anything.
  r.get('/set-password-info', (req, res) => {
    const t = peekToken(db, String(req.query.token || ''), ['set_password', 'reset_password'])
    if (!t) throw new HttpError(400, 'This link is invalid or has expired. Use "Forgot password" on the sign-in page, or ask the hospital admin for a new one.')
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(t.userId)
    res.json({ name: u.name, email: u.email })
  })

  r.post(
    '/set-password',
    wrap(async (req, res) => {
      const { token, password } = parse(setPasswordBody, req.body)
      const problem = passwordProblem(password)
      if (problem) throw new HttpError(400, problem)
      const t = peekToken(db, token, ['set_password', 'reset_password'])
      if (!t) throw new HttpError(400, 'This link is invalid or has expired. Use "Forgot password" on the sign-in page, or ask the hospital admin for a new one.')
      const hash = await hashPassword(password, config.bcryptCost)
      db.transaction(() => {
        if (!consumeToken(db, t.id)) throw new HttpError(400, 'This link has already been used.')
        db.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(hash, new Date().toISOString(), t.userId)
        destroyUserSessions(db, t.userId)
      })()
      res.json({ ok: true })
    })
  )

  return r
}
