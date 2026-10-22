import { deliver } from './deliveries.js'

// Every email goes through here. The transport is the viaSocket "email_sender" slot; with no transport (or a slot
// that is not set up yet) the email is recorded as "skipped". Each email has a unique key: it is never sent twice.
export function createMailer({ db, transport = null, now = () => new Date() }) {
  async function send({ type, dedupeKey, to, subject, html, appointmentId = null }) {
    return deliver(db, { channel: 'email', type, dedupeKey, appointmentId, recipient: to, now }, async () => {
      if (!transport) {
        const e = new Error('Email is not set up yet (Integrations page)')
        e.code = 'not_configured'
        throw e
      }
      await transport.sendEmail({ to, subject, body: html })
    })
  }
  return { send }
}
