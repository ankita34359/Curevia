// Every email goes through here. The transport is the viaSocket "email_sender" slot (wired in stage 4);
// until it exists emails are recorded as "skipped". Each email has a unique key, so it is never sent twice.
export function createMailer({ db, transport = null, now = () => new Date() }) {
  const find = db.prepare('SELECT id, status FROM deliveries WHERE dedupe_key = ?')
  const insert = db.prepare(
    `INSERT INTO deliveries (channel, type, dedupe_key, appointment_id, recipient, status, error, created_at, updated_at)
     VALUES ('email', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const update = db.prepare('UPDATE deliveries SET status = ?, error = ?, updated_at = ? WHERE id = ?')

  async function send({ type, dedupeKey, to, subject, html, appointmentId = null }) {
    const existing = find.get(dedupeKey)
    if (existing && existing.status !== 'failed') return { status: existing.status, duplicate: true }

    let status = 'skipped'
    let error = null
    if (transport) {
      try {
        await transport.sendEmail({ to, subject, body: html })
        status = 'sent'
      } catch (e) {
        status = 'failed'
        error = String(e.message || e).slice(0, 300)
      }
    } else {
      error = 'Email is not set up yet (Integrations page)'
    }
    const t = now().toISOString()
    if (existing) update.run(status, error, t, existing.id)
    else insert.run(type, dedupeKey, appointmentId, to, status, error, t, t)
    return { status, error }
  }
  return { send }
}
