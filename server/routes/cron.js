import crypto from 'node:crypto'
import { Router } from 'express'
import { wrap } from '../lib/http.js'

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

// Embarko's scheduler calls this with GET; the brief says POST, so both work. Both need "Authorization: Bearer <CRON_SECRET>".
export function cronRoutes({ config, tick }) {
  const r = Router()
  const handler = wrap(async (req, res) => {
    const ok = config.cronSecret && crypto.timingSafeEqual(digest(req.get('authorization') || ''), digest(`Bearer ${config.cronSecret}`))
    if (!ok) return res.status(401).json({ error: 'Unauthorized' })
    const result = await tick.run()
    res.json({ ok: true, ...result })
  })
  r.get('/tick', handler)
  r.post('/tick', handler)
  return r
}
