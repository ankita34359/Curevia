import crypto from 'node:crypto'

// The "how was your visit?" link: <appointment id>.<HMAC signature>. It is signed with the server secret, so it cannot be
// guessed or edited to point at another visit, and it can be rebuilt (for a retried email) without storing anything.
// It is one-time because there is at most one feedback per appointment: after it is sent the link only says "already received".
const mac = (secret, id) => crypto.createHmac('sha256', secret).update(`feedback:v1:${id}`).digest('base64url')

export const signFeedbackToken = (secret, appointmentId) => `${appointmentId}.${mac(secret, appointmentId)}`

// Returns the appointment id, or null when the token is not a valid signed token.
export function verifyFeedbackToken(secret, token) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''))
  if (!m) return null
  const given = Buffer.from(m[2])
  const expected = Buffer.from(mac(secret, m[1]))
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? Number(m[1]) : null
}

export const feedbackLink = (appUrl, secret, appointmentId) => `${appUrl}/feedback/${signFeedbackToken(secret, appointmentId)}`
