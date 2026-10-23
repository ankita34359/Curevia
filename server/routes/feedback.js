import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { HttpError, parse, wrap } from '../lib/http.js'
import { verifyFeedbackToken } from '../services/feedbackToken.js'

// The page behind the emailed link. No sign-in: the signed link itself is the proof, and it belongs to ONE visit.
// It shows only the doctor's name and the visit date. After feedback is sent the link only says "already received".
export function feedbackRoutes({ config, feedback, notifier }) {
  const r = Router()
  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Please try again later.' })
  })
  const visit = (req) => {
    const id = verifyFeedbackToken(config.sessionSecret, req.params.token)
    const info = id ? feedback.formInfo(id) : null
    if (!info) throw new HttpError(404, 'This feedback link is not valid')
    if (!info.submitted && feedback.requestExpired(id)) throw new HttpError(410, 'This feedback link has expired')
    return info
  }

  r.get('/:token', (req, res) => {
    res.json({ feedback: visit(req) })
  })

  r.post('/:token', limiter, wrap(async (req, res) => {
    const info = visit(req)
    const input = parse(feedback.ratingBody, req.body ?? {})
    const out = await feedback.submit(info.appointmentId, input)
    notifier.emit('feedback_received', { appointmentId: info.appointmentId }) // the Google Sheet row
    res.status(201).json({ submitted: true, urgent: out.urgent })
  }))

  return r
}
