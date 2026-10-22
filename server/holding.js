import express from 'express'

// Used when required settings are missing (e.g. the first deploy, before the secrets page is filled in).
// The app stays up so the host sees it running; everything but /healthz answers 503 with the missing NAMES only.
export function createHoldingApp(message) {
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_req, res) => res.json({ ok: true, ready: false }))
  app.use((req, res) => {
    res.status(503)
    if (req.path.startsWith('/api')) return res.json({ error: message })
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Curevia is being set up</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#12303a"><h1>Curevia is being set up</h1><p>The site will be ready shortly.</p></body>`)
  })
  return app
}
