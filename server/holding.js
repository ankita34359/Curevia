import crypto from 'node:crypto'
import express from 'express'

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

// Used when required settings are missing (e.g. the first deploy, before the secrets page is filled in).
// The app stays up so the host sees it running; everything but /healthz answers 503 with the missing NAMES only.
export function createHoldingApp(message, { cronSecret = '' } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_req, res) => res.json({ ok: true, ready: false }))
  // The 5-minute schedule must get an answer even now. Same bearer check as the real route (401 without it), then a
  // quick 503 that says why nothing ran, so the schedule shows a clear failure instead of hanging.
  app.all('/api/cron/tick', (req, res) => {
    const ok = cronSecret && crypto.timingSafeEqual(digest(req.get('authorization') || ''), digest(`Bearer ${cronSecret}`))
    if (!ok) return res.status(401).json({ error: 'Unauthorized' })
    res.status(503).json({ error: message, ran: false })
  })
  app.use((req, res) => {
    res.status(503)
    if (req.path.startsWith('/api')) return res.json({ error: message })
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Curevia is being set up</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#12303a"><h1>Curevia is being set up</h1><p>The site will be ready shortly.</p></body>`)
  })
  return app
}
