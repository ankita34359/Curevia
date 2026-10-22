// Records every outgoing email / sheet row / Slack message in `deliveries` as sent, failed or skipped.
// dedupe_key is unique, so the same thing is never sent twice: an already-sent key is returned as a duplicate.
// A failed or skipped one may be tried again (the row is updated, not duplicated).
export class NotConfigured extends Error {
  constructor(message = 'This integration is not set up yet') {
    super(message)
    this.code = 'not_configured'
  }
}

const inflight = new Set() // stops two simultaneous runs of the same key from both sending

export async function deliver(db, { channel, type, dedupeKey, appointmentId = null, recipient = null, now = () => new Date() }, run) {
  const existing = db.prepare('SELECT id, status FROM deliveries WHERE dedupe_key = ?').get(dedupeKey)
  if (existing?.status === 'sent') return { status: 'sent', duplicate: true }
  if (inflight.has(dedupeKey)) return { status: 'pending', duplicate: true }
  inflight.add(dedupeKey)
  try {
    let status = 'sent'
    let error = null
    try {
      await run()
    } catch (e) {
      if (e?.code === 'not_configured') { status = 'skipped'; error = e.message } else { status = 'failed'; error = String(e?.message || e).slice(0, 300) }
    }
    const t = now().toISOString()
    if (existing) db.prepare('UPDATE deliveries SET status = ?, error = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ?').run(status, error, t, existing.id)
    else db.prepare('INSERT INTO deliveries (channel, type, dedupe_key, appointment_id, recipient, status, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(channel, type, dedupeKey, appointmentId, recipient, status, error, t, t)
    return { status, error }
  } finally {
    inflight.delete(dedupeKey)
  }
}
