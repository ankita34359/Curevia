import crypto from 'node:crypto'
import { Router } from 'express'
import { wrap } from '../lib/http.js'

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

// Embarko's scheduler calls this with GET; the brief says POST, so both work. Both need "Authorization: Bearer <CRON_SECRET>".
// It replies 202 at once and does the reminders, retries and agent in the background (see services/tick.js).
export function cronRoutes({ config, tick }) {
  const r = Router()
  const handler = wrap(async (req, res) => {
    const ok = config.cronSecret && crypto.timingSafeEqual(digest(req.get('authorization') || ''), digest(`Bearer ${config.cronSecret}`))
    if (!ok) return res.status(401).json({ error: 'Unauthorized' })
    // Answer right away: the work can take minutes and Embarko gives up on a call after 300 s.
    const { started, skipped } = tick.start()
    res.status(202).json({ accepted: true, started, ...(skipped ? { skipped } : {}) })
  })
  r.get('/tick', handler)
  r.post('/tick', handler)
  return r
}
