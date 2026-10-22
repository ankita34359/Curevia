import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { HttpError } from './lib/http.js'
import { attachUser, requireRole, sameOriginWrites } from './auth/middleware.js'
import { authRoutes } from './routes/auth.js'

const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

// Page prefixes that belong to one role. The server refuses other roles; the React app only mirrors this.
const PAGE_ROLES = [
  ['/admin', 'admin'],
  ['/doctor', 'doctor'],
  ['/my', 'patient']
]

export function createApp(ctx) {
  const { config, db } = ctx
  const app = express()
  app.set('trust proxy', config.trustProxy)
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false })) // CSP is added with the Integrations page (stage 4)
  app.use(express.json({ limit: '100kb' }))
  app.use(cookieParser(config.sessionSecret))
  app.use(sameOriginWrites(config.appUrl))
  app.use(attachUser(db))

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  app.use('/api/auth', authRoutes(ctx))
  // Role routers are mounted here as the stages add them, always behind requireRole.
  const roleRouters = ctx.roleRouters || {}
  if (roleRouters.admin) app.use('/api/admin', requireRole('admin'), roleRouters.admin)
  if (roleRouters.doctor) app.use('/api/doctor', requireRole('doctor'), roleRouters.doctor)
  if (roleRouters.patient) app.use('/api/patient', requireRole('patient'), roleRouters.patient)
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))

  // Role-restricted pages: sign-in required, then the right role.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    const rule = PAGE_ROLES.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`))
    if (!rule) return next()
    if (!req.user) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`)
    if (req.user.role !== rule[1]) res.status(403)
    next()
  })

  const indexFile = path.join(CLIENT_DIST, 'index.html')
  if (fs.existsSync(indexFile)) {
    app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }))
    app.get('*', (_req, res) => res.sendFile(indexFile))
  } else {
    app.get('*', (_req, res) => res.type('text').send('Curevia: the web client has not been built yet (npm run build).'))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra })
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' })
    console.error(`Unhandled error on ${req.method} ${req.path}: ${err?.message}`) // never log bodies or patient data
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  })
  return app
}
