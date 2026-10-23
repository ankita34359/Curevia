import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { makeApp, login, agentFor, addDoctor, addPatient, addAppointment, ADMIN, FLOW_URL } from './helpers.js'
import { signFeedbackToken, verifyFeedbackToken } from '../server/services/feedbackToken.js'
import { scrub, FEEDBACK_PROMPT, FEEDBACK_SCHEMA } from '../server/services/feedback.js'
import { migrations } from '../server/db/migrations.js'

const MIN = 60000
const DAY = 86400000
const ist = (hhmm, day = '2026-10-22') => new Date(`${day}T${hhmm}:00+05:30`)
const never = () => new Promise(() => {})
const say = (content) => () => ({ content, finishReason: 'completed' })
const sorted = (category, summary = 'Summary line.', reason = 'Because.') => say({ category, summary, reason })
const CFG = (quietHours = true) => ({ agent: { service: 'openai', model: 'gpt-5-mini', demoMinutes: null, quietHours } })
const feedbackMails = (w, to = 'pat@test.local') => w.emails.sent.filter((m) => m.to === to && /^How was your visit/.test(m.subject))
const linkOf = (mail) => /href="[^"]*\/feedback\/([^"]+)"/.exec(mail.body)[1]
const slack = (w) => w.fake.postsTo('slack_alert')
const sheetRows = (w) => w.fake.postsTo('appointments_sheet').filter((p) => p.event === 'feedback_received')
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)) } }

// One confirmed visit that already took place; the doctor marks it completed with `complete()`.
async function world({ now = ist('09:30'), config, off, timeouts, feedbackWaitMs } = {}) {
  const w = await makeApp({ now, config, off, timeouts, feedbackWaitMs })
  const doc = addDoctor(w.db, { email: 'doc@test.local', name: 'Dr One' })
  const doc2 = addDoctor(w.db, { email: 'doc2@test.local', name: 'Dr Two', dept: 'Cardiology' })
  const patientId = addPatient(w.db, 'pat@test.local', 'Asha Patient')
  const visit = (doctor, startUtc = '2026-10-22T02:00:00.000Z', status = 'confirmed') => addAppointment(w.db, { doctorId: doctor.doctorId, patientId, startUtc, status, name: 'Asha Patient' })
  const id = visit(doc)
  const doctor = await login(w.app, 'doc@test.local', 'password-123')
  const doctor2 = await login(w.app, 'doc2@test.local', 'password-123')
  const patient = await login(w.app, 'pat@test.local', 'password-123')
  const admin = await login(w.app, ADMIN.email, ADMIN.password)
  const complete = async (appId = id, agent = doctor) => { const r = await agent.post(`/api/doctor/appointments/${appId}/complete`); await w.notifier.flush(); return r }
  const anon = () => agentFor(w.app)
  const send = async (token, body, agent = anon()) => { const r = await agent.post(`/api/feedback/${token}`).send(body); await w.notifier.flush(); return r }
  return { ...w, doc, doc2, patientId, id, visit, doctor, doctor2, patient, admin, complete, anon, send, set: (d) => { w.clock.now = d } }
}
// A completed visit whose emailed link we have.
async function withLink(opts) {
  const w = await world(opts)
  await w.complete()
  const mail = feedbackMails(w)[0]
  return { ...w, token: linkOf(mail), mail }
}

describe('the email after a completed visit', () => {
  it('the patient gets ONE "How was your visit with Dr X?" email with a button to the feedback page', async () => {
    const w = await world()
    expect((await w.complete()).status).toBe(200)
    const mails = feedbackMails(w)
    expect(mails).toHaveLength(1)
    expect(mails[0].subject).toBe('How was your visit with Dr One?')
    expect(mails[0].body).toContain('Dr One')
    expect(mails[0].body).toContain('Share my feedback')
    expect(mails[0].body).toContain(`${w.config.appUrl}/feedback/${w.id}.`)
    expect(mails[0].body).toMatch(/call 108/)
    expect(w.emails.sent.filter((m) => m.to === 'doc@test.local')).toHaveLength(0) // only the patient
    expect(w.db.prepare("SELECT dedupe_key, status FROM deliveries WHERE type = 'patient_feedback_request'").all()).toEqual([{ dedupe_key: `email:patient_feedback_request:${w.id}`, status: 'sent' }])
  })

  it('once only: later ticks, repeated events and a restart never send it again', async () => {
    const w = await world()
    await w.complete()
    for (let i = 0; i < 4; i++) { w.set(new Date(w.clock.now.getTime() + 5 * MIN)); await w.tick.run() }
    await w.notifier.emit('completed', { appointmentId: w.id })
    await w.notifier.flush()
    expect(feedbackMails(w)).toHaveLength(1)
  })

  it('a visit that is not completed, or was completed before this feature existed, gets no email', async () => {
    const w = await world()
    const old = w.visit(w.doc, '2026-10-21T02:00:00.000Z', 'completed') // inserted directly: no completion event after the release
    await w.tick.run()
    expect(feedbackMails(w)).toHaveLength(0)
    expect(w.db.prepare('SELECT COUNT(*) n FROM feedback_requests WHERE appointment_id = ?').get(old).n).toBe(0)
    const noshow = w.visit(w.doc, '2026-10-20T02:00:00.000Z', 'confirmed')
    await w.doctor.post(`/api/doctor/appointments/${noshow}/no-show`)
    await w.notifier.flush()
    expect(feedbackMails(w)).toHaveLength(0)
  })

  it('a failed send is tried again and goes out once; with no email slot nothing is lost', async () => {
    const w = await world()
    w.fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    await w.complete()
    expect(feedbackMails(w)).toHaveLength(0)
    w.fake.replyFor = null
    w.set(new Date(w.clock.now.getTime() + 5 * MIN)); await w.tick.run()
    w.set(new Date(w.clock.now.getTime() + 5 * MIN)); await w.tick.run()
    expect(feedbackMails(w)).toHaveLength(1)
    expect(linkOf(feedbackMails(w)[0])).toMatch(new RegExp(`^${w.id}\\.`))
  })

  it('is skipped (not failed) when the email slot is not set up, and the visit still completes', async () => {
    const w = await world({ off: ['email_sender'] })
    expect((await w.complete()).status).toBe(200)
    expect(w.db.prepare("SELECT status FROM deliveries WHERE type = 'patient_feedback_request'").get().status).toBe('skipped')
  })
})

describe('quiet hours (10 PM to 8 AM IST)', () => {
  it('completed at 11 PM: nothing now, one email at 8 AM (not before), and never twice', async () => {
    const w = await world({ now: ist('23:00'), config: CFG() })
    await w.complete()
    expect(feedbackMails(w)).toHaveLength(0)
    expect(w.db.prepare('SELECT send_after FROM feedback_requests').get().send_after).toBe('2026-10-23T02:30:00.000Z') // 08:00 IST tomorrow
    await w.tick.run()
    w.set(ist('02:00', '2026-10-23')); await w.tick.run()
    w.set(new Date(ist('08:00', '2026-10-23').getTime() - 1000)); await w.tick.run() // 07:59:59
    expect(feedbackMails(w)).toHaveLength(0)
    w.set(ist('08:00', '2026-10-23'))
    expect((await w.tick.run()).feedback).toMatchObject({ requestsSent: 1 })
    expect(feedbackMails(w)).toHaveLength(1)
    for (let i = 0; i < 3; i++) { w.set(new Date(w.clock.now.getTime() + 5 * MIN)); await w.tick.run() }
    expect(feedbackMails(w)).toHaveLength(1)
  })

  it('completed at 3 AM goes out at 8 AM the same day; 9:59 PM goes out at once', async () => {
    const early = await world({ now: ist('03:00'), config: CFG() })
    await early.complete(early.visit(early.doc, '2026-10-21T08:00:00.000Z')) // yesterday's visit (today's 7:30 AM one has not started yet)
    expect(feedbackMails(early)).toHaveLength(0)
    early.set(ist('08:00')); await early.tick.run()
    expect(feedbackMails(early)).toHaveLength(1)
    const evening = await world({ now: ist('21:59'), config: CFG() })
    await evening.complete()
    expect(feedbackMails(evening)).toHaveLength(1)
  })

  it('a tick that only runs after 10 PM does not send a held email, and a failed one is not retried at night', async () => {
    const w = await world({ now: ist('21:00'), config: CFG() })
    w.fake.replyFor = (url) => (url === FLOW_URL('email_sender') ? { status: 500, body: { message: 'boom' } } : undefined)
    await w.complete() // 9 PM: sent now, but the send fails
    w.fake.replyFor = null
    w.set(ist('23:00')); await w.tick.run() // retry window is night: held
    expect(feedbackMails(w)).toHaveLength(0)
    w.set(ist('08:00', '2026-10-23')); await w.tick.run()
    expect(feedbackMails(w)).toHaveLength(1)
  })

  it('a patient who already gave feedback from Visit history is not emailed at 8 AM', async () => {
    const w = await world({ now: ist('23:00'), config: CFG() })
    w.fake.ai = sorted('praise')
    await w.complete()
    expect((await w.patient.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 5 })).status).toBe(201)
    w.set(ist('08:00', '2026-10-23')); await w.tick.run()
    expect(feedbackMails(w)).toHaveLength(0)
  })

  it('AGENT_QUIET_HOURS=off sends at once, also at night', async () => {
    const w = await world({ now: ist('23:00'), config: CFG(false) })
    await w.complete()
    expect(feedbackMails(w)).toHaveLength(1)
  })
})

describe('the signed one-time link', () => {
  it('opens without signing in and shows only the doctor and the visit date', async () => {
    const w = await withLink()
    const r = await w.anon().get(`/api/feedback/${w.token}`).expect(200)
    expect(r.body.feedback).toMatchObject({ doctorName: 'Dr One', department: 'General', visitDate: '22 Oct 2026', submitted: false, urgent: false })
    expect(JSON.stringify(r.body)).not.toMatch(/Asha|9000000000|pat@test|doc@test/)
  })

  it('works once: a second try with the same link says "already", whatever is sent', async () => {
    const w = await withLink()
    w.fake.ai = sorted('praise')
    expect((await w.send(w.token, { rating: 5, comment: 'Lovely doctor' })).status).toBe(201)
    const again = await w.send(w.token, { rating: 1, comment: 'Changed my mind' })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ code: 'already_submitted' })
    expect(w.db.prepare('SELECT rating, comment FROM feedback').all()).toEqual([{ rating: 5, comment: 'Lovely doctor' }])
    const page = (await w.anon().get(`/api/feedback/${w.token}`).expect(200)).body.feedback
    expect(page).toMatchObject({ submitted: true, rating: 5 })
    expect(JSON.stringify(page)).not.toContain('Lovely doctor') // the link does not show the comment back
  })

  it('one feedback per visit, whichever way it comes: link then Visit history, history then link, or two at the same moment', async () => {
    const a = await withLink()
    a.fake.ai = sorted('praise')
    expect((await a.send(a.token, { rating: 4 })).status).toBe(201)
    expect((await a.patient.post(`/api/patient/appointments/${a.id}/feedback`).send({ rating: 3 })).status).toBe(409)
    const b = await withLink()
    b.fake.ai = sorted('praise')
    expect((await b.patient.post(`/api/patient/appointments/${b.id}/feedback`).send({ rating: 3 })).status).toBe(201)
    expect((await b.send(b.token, { rating: 5 })).status).toBe(409)
    const c = await withLink()
    c.fake.ai = sorted('praise')
    const both = await Promise.all([c.send(c.token, { rating: 5 }), c.send(c.token, { rating: 2 })])
    expect(both.map((r) => r.status).sort()).toEqual([201, 409])
    expect(c.db.prepare('SELECT COUNT(*) n FROM feedback').get().n).toBe(1)
    expect(c.fake.aiCalls).toHaveLength(1) // one feedback, one AI call
    expect(sheetRows(c)).toHaveLength(1)
  })

  it('a link that was edited, forged or signed with another secret is refused', async () => {
    const w = await withLink()
    const [id, mac] = w.token.split('.')
    const other = w.visit(w.doc, '2026-10-22T02:30:00.000Z', 'confirmed')
    await w.complete(other)
    for (const bad of [`${Number(id) + 100}.${mac}`, `${other}.${mac}`, `${id}.${mac.slice(0, -2)}xx`, `${id}.`, id, 'abc', `${id}.${'A'.repeat(43)}`, signFeedbackToken('another-secret-entirely-1234', id)]) {
      expect((await w.anon().get(`/api/feedback/${bad}`)).status, bad).toBe(404)
      expect((await w.send(bad, { rating: 5 })).status, bad).toBe(404)
    }
    expect(w.db.prepare('SELECT COUNT(*) n FROM feedback').get().n).toBe(0)
    expect(verifyFeedbackToken(w.config.sessionSecret, w.token)).toBe(Number(id))
    expect(verifyFeedbackToken(w.config.sessionSecret, `${other}.${mac}`)).toBeNull()
  })

  it('a link for a visit that is not completed does nothing', async () => {
    const w = await world()
    const token = signFeedbackToken(w.config.sessionSecret, w.id) // validly signed, but the visit is only confirmed
    expect((await w.anon().get(`/api/feedback/${token}`)).status).toBe(404)
    expect((await w.send(token, { rating: 5 })).status).toBe(404)
  })

  it('expires after 30 days, unless it was already used', async () => {
    const w = await withLink()
    w.set(new Date(w.clock.now.getTime() + 31 * DAY))
    expect((await w.anon().get(`/api/feedback/${w.token}`)).status).toBe(410)
    expect((await w.send(w.token, { rating: 5 })).status).toBe(410)
    const x = await withLink()
    x.fake.ai = sorted('praise')
    await x.send(x.token, { rating: 5 })
    x.set(new Date(x.clock.now.getTime() + 60 * DAY))
    expect((await x.anon().get(`/api/feedback/${x.token}`)).body.feedback.submitted).toBe(true)
  })

  it('is rate limited (30 tries an hour from one address)', async () => {
    const w = await withLink()
    let last
    for (let i = 0; i < 31; i++) last = await w.anon().post(`/api/feedback/${w.token}`).send({ rating: 9 })
    expect(last.status).toBe(429)
  })
})

describe('the form: 1-5 stars and an optional comment of up to 500 characters', () => {
  it('rejects a rating outside 1-5, a missing or fractional one, and a long comment; stores nothing', async () => {
    const w = await withLink()
    for (const body of [{}, { rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: '5' }, { rating: null }, { rating: 5, comment: 'x'.repeat(501) }, { rating: 5, comment: 123 }]) {
      expect((await w.send(w.token, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400)
    }
    expect(w.db.prepare('SELECT COUNT(*) n FROM feedback').get().n).toBe(0)
  })
  it('the comment is optional, trimmed, and exactly 500 characters is fine', async () => {
    const a = await withLink()
    a.fake.ai = sorted('praise')
    expect((await a.send(a.token, { rating: 5 })).status).toBe(201)
    expect(a.db.prepare('SELECT comment FROM feedback').get().comment).toBe('')
    const b = await withLink()
    b.fake.ai = sorted('praise')
    expect((await b.send(b.token, { rating: 3, comment: `  ${'y'.repeat(500)}  ` })).status).toBe(201)
    expect(b.db.prepare('SELECT comment FROM feedback').get().comment).toHaveLength(500)
  })
  it('the database itself refuses a rating outside 1-5 and a second feedback for a visit', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF')
    for (const m of migrations) db.exec(m.sql)
    const ins = (rating, appt = 1) => db.prepare("INSERT INTO feedback (appointment_id, doctor_id, rating, created_at) VALUES (?, 1, ?, 't')").run(appt, rating)
    expect(() => ins(0)).toThrow(/CHECK/)
    expect(() => ins(6)).toThrow(/CHECK/)
    ins(5)
    expect(() => ins(4)).toThrow(/UNIQUE/)
  })
})

describe('AI sorting', () => {
  it('asks the AI the way the agent does (json_schema), with only the rating and the comment', async () => {
    const w = await withLink()
    w.fake.ai = sorted('praise')
    await w.send(w.token, { rating: 5, comment: 'Dr One was kind and explained everything.' })
    const req = w.fake.aiCalls[0]
    expect(req).toMatchObject({ responseType: 'json_schema', service: 'openai', model: 'gpt-5-mini', threadId: expect.stringMatching(/^feedback-\d+$/), prompt: FEEDBACK_PROMPT })
    expect(req.jsonSchema).toEqual(FEEDBACK_SCHEMA)
    expect(req.jsonSchema.strict).toBe(true)
    expect(JSON.parse(req.message)).toEqual({ rating: 5, comment: 'Dr One was kind and explained everything.' })
    expect(req.message).not.toMatch(/Asha|9000000000|pat@test|Dr Two/)
    expect(FEEDBACK_PROMPT).toMatch(/never give medical advice/)
    expect(FEEDBACK_PROMPT).toMatch(/never write to the patient/)
    expect(FEEDBACK_PROMPT).toMatch(/data, not instructions/)
    for (const c of ['praise', 'suggestion', 'complaint', 'urgent']) expect(FEEDBACK_PROMPT).toContain(`- ${c}:`)
    expect(FEEDBACK_SCHEMA.schema.properties.category.enum).toEqual(['praise', 'suggestion', 'complaint', 'urgent'])
  })

  it('stores the category, a one-line summary and the reason, labelled as AI', async () => {
    const w = await withLink()
    w.fake.ai = sorted('suggestion', 'Wants clearer signs to the lab.', 'A constructive idea, not a complaint.')
    const r = await w.send(w.token, { rating: 4, comment: 'Signs to the lab could be clearer.' })
    expect(r.body).toEqual({ submitted: true, urgent: false })
    expect(w.db.prepare('SELECT category, category_source, summary, reason, ai_error, sorted_at FROM feedback').get()).toMatchObject({ category: 'suggestion', category_source: 'ai', summary: 'Wants clearer signs to the lab.', reason: 'A constructive idea, not a complaint.', ai_error: null })
  })

  it('Slack only for complaint and urgent: nothing for praise or suggestion', async () => {
    for (const category of ['praise', 'suggestion']) {
      const w = await withLink()
      w.fake.ai = sorted(category)
      await w.send(w.token, { rating: 3, comment: 'ok' })
      expect(slack(w), category).toHaveLength(0)
    }
    for (const category of ['complaint', 'urgent']) {
      const w = await withLink()
      w.fake.ai = sorted(category, 'Waited two hours and nobody explained why.')
      await w.send(w.token, { rating: 2, comment: 'Waited two hours.' })
      expect(slack(w), category).toHaveLength(1)
    }
  })

  it('the Slack alert names the doctor, rating, category and summary, and never the patient\'s phone, email or name', async () => {
    const w = await withLink()
    w.fake.ai = sorted('complaint', 'Waited two hours and nobody explained why.')
    await w.send(w.token, { rating: 2, comment: 'Waited two hours. Call me on 9000000000 or pat@test.local.' })
    const text = slack(w)[0].text
    expect(text).toContain('COMPLAINT')
    expect(text).toContain('Dr One')
    expect(text).toContain('General')
    expect(text).toContain('rating 2/5')
    expect(text).toContain('Waited two hours and nobody explained why.')
    expect(text).toContain(`${w.config.appUrl}/admin/feedback`)
    expect(text).not.toMatch(/9000000000|pat@test|Asha|Patient/)
    expect(text).not.toContain('Call me') // not the raw comment either
  })

  it('urgent: the thank-you answer says so (so the page can show "call 108"), and also when the link is opened again', async () => {
    const w = await withLink()
    w.fake.ai = sorted('urgent', 'Reports a severe reaction after the injection.', 'Mentions a medical emergency.')
    const r = await w.send(w.token, { rating: 1, comment: 'I had a severe reaction after the injection and need help.' })
    expect(r.body).toEqual({ submitted: true, urgent: true })
    expect(slack(w)).toHaveLength(1)
    expect(slack(w)[0].text).toContain('URGENT')
    expect((await w.anon().get(`/api/feedback/${w.token}`)).body.feedback).toMatchObject({ submitted: true, urgent: true })
    const calm = await withLink()
    calm.fake.ai = sorted('complaint')
    expect((await calm.send(calm.token, { rating: 1, comment: 'Rude.' })).body.urgent).toBe(false)
  })

  it('whatever the AI writes is cleaned: no email addresses, phone numbers or HTML in the summary and reason', async () => {
    const w = await withLink()
    w.fake.ai = sorted('complaint', 'Call back at +91 98765 43210 or a@b.com <b>now</b>', 'Left <script>x</script> his email me@x.org')
    await w.send(w.token, { rating: 2, comment: 'Bad' })
    const row = w.db.prepare('SELECT summary, reason FROM feedback').get()
    expect(`${row.summary} ${row.reason}`).not.toMatch(/98765|a@b\.com|me@x\.org|<|>/)
    expect(row.summary).toContain('[number removed]')
    expect(row.summary).toContain('[email removed]')
    expect(scrub('x'.repeat(300), 160)).toHaveLength(160)
    expect(scrub(null, 10)).toBe('')
  })

  it('sends the sheet row feedback_received (status stays completed), once, whatever the category', async () => {
    const w = await withLink()
    w.fake.ai = sorted('praise')
    await w.send(w.token, { rating: 5, comment: 'Great' })
    expect(sheetRows(w)).toHaveLength(1)
    expect(sheetRows(w)[0]).toMatchObject({ appointment_id: w.id, status: 'completed', event: 'feedback_received', doctor: 'Dr One' })
    await w.send(w.token, { rating: 1 }) // refused: no second row
    expect(sheetRows(w)).toHaveLength(1)
    expect(w.fake.postsTo('appointments_sheet').filter((p) => p.event === 'completed')).toHaveLength(1) // the completion row is unchanged
  })
})

describe('when the AI cannot be used', () => {
  const FALLBACK_CASES = [[1, 'complaint'], [2, 'complaint'], [3, null], [4, null], [5, null]]
  it('rating 2 or lower = complaint (and a Slack alert), anything else stays unsorted; both are labelled "rule"', async () => {
    for (const [rating, expected] of FALLBACK_CASES) {
      const w = await withLink()
      w.fake.ai = null // the AI call throws
      const r = await w.send(w.token, { rating, comment: 'A comment' })
      expect(r.status).toBe(201)
      const row = w.db.prepare('SELECT category, category_source, summary, reason, ai_error FROM feedback').get()
      expect(row.category, `rating ${rating}`).toBe(expected)
      expect(row.category_source).toBe('rule')
      expect(row.ai_error).toBeTruthy()
      expect(row.reason).toMatch(/AI could not be used/)
      expect(slack(w)).toHaveLength(expected ? 1 : 0)
      if (expected) expect(slack(w)[0].text).toMatch(/COMPLAINT \(by rule\)/)
    }
  })

  it('also for an answer in the wrong shape, an unknown category, or text that is not JSON', async () => {
    for (const bad of [say({ nonsense: true }), say({ category: 'dance', summary: 's', reason: 'r' }), say('not json at all'), say({ category: 'praise' })]) {
      const w = await withLink()
      w.fake.ai = bad
      await w.send(w.token, { rating: 2, comment: 'x' })
      expect(w.db.prepare('SELECT category, category_source FROM feedback').get()).toEqual({ category: 'complaint', category_source: 'rule' })
    }
  })

  it('an AI that never answers is cut off by the time limit and the rule is used', async () => {
    const w = await withLink({ timeouts: { aiTimeoutMs: 30 } })
    w.fake.ai = never
    const t0 = Date.now()
    await w.send(w.token, { rating: 1, comment: 'x' })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(w.db.prepare('SELECT category, ai_error FROM feedback').get()).toMatchObject({ category: 'complaint', ai_error: expect.stringMatching(/did not answer in time/) })
  })

  it('the failure is logged (the reason, never the comment) and shown on the admin page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await withLink()
    w.fake.ai = () => { throw new Error('502 from viaSocket') }
    await w.send(w.token, { rating: 1, comment: 'My secret comment' })
    const logged = warn.mock.calls.map((c) => c.join(' ')).filter((l) => /Feedback #/.test(l))
    warn.mockRestore()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/AI sorting failed \(502 from viaSocket\); used the rating rule \(category: complaint\)/)
    expect(logged[0]).not.toContain('My secret comment')
    const item = (await w.admin.get('/api/admin/feedback').expect(200)).body.feedback[0]
    expect(item).toMatchObject({ category: 'complaint', categorySource: 'rule', aiError: '502 from viaSocket' })
  })

  it('works when viaSocket is not set up at all', async () => {
    const w = await withLink()
    w.ctx.viasocket.ai = async () => { throw new Error('viaSocket is not set up') }
    w.services.feedback // the same service instance serves the routes
    await w.send(w.token, { rating: 2, comment: 'x' })
    expect(w.db.prepare('SELECT category_source FROM feedback').get().category_source).toBe('rule')
  })
})

describe('the patient does not wait for a slow AI, and nothing is left unsorted', () => {
  it('the thank-you comes back after at most the wait limit; the sorting finishes afterwards and alerts once', async () => {
    const w = await withLink({ feedbackWaitMs: 20 })
    w.fake.ai = () => new Promise((r) => setTimeout(() => r({ content: { category: 'complaint', summary: 'Slow answer.', reason: 'Because.' }, finishReason: 'completed' }), 150))
    const t0 = Date.now()
    const r = await w.send(w.token, { rating: 2, comment: 'x' })
    expect(Date.now() - t0).toBeLessThan(140)
    expect(r.body).toEqual({ submitted: true, urgent: false }) // not known yet
    expect(w.db.prepare('SELECT category FROM feedback').get().category).toBeNull()
    await waitFor(() => w.db.prepare('SELECT sorted_at FROM feedback').get().sorted_at)
    expect(w.db.prepare('SELECT category, category_source FROM feedback').get()).toEqual({ category: 'complaint', category_source: 'ai' })
    await waitFor(() => slack(w).length === 1)
  })

  it('a feedback the AI never got to (for example the server restarted) is sorted by the tick, once', async () => {
    const w = await withLink()
    w.fake.ai = sorted('complaint', 'Picked up by the tick.')
    w.db.prepare("INSERT INTO feedback (appointment_id, doctor_id, rating, comment, created_at) VALUES (?, ?, 2, 'Slow', ?)").run(w.id, w.doc.doctorId, new Date(w.clock.now.getTime() - 5 * MIN).toISOString())
    const r = await w.tick.run()
    expect(r.feedback).toMatchObject({ sorted: 1 })
    expect(w.db.prepare('SELECT category, category_source FROM feedback').get()).toEqual({ category: 'complaint', category_source: 'ai' })
    await w.tick.run()
    expect(slack(w)).toHaveLength(1)
    expect(w.fake.aiCalls).toHaveLength(1)
  })
})

describe('who can see and send what', () => {
  async function filled() {
    const w = await world()
    const b = w.visit(w.doc, '2026-10-21T02:00:00.000Z', 'confirmed')
    const c = w.visit(w.doc2, '2026-10-20T02:00:00.000Z', 'confirmed')
    await w.complete(w.id); await w.complete(b); await w.complete(c, w.doctor2)
    const answers = [[w.id, 5, 'Wonderful care', sorted('praise')], [b, 1, 'Waited far too long', sorted('complaint', 'Long wait.')], [c, 3, 'Okay visit', sorted('suggestion', 'Wants shorter forms.')]]
    for (const [appt, rating, comment, ai] of answers) {
      w.fake.ai = ai
      await w.send(signFeedbackToken(w.config.sessionSecret, appt), { rating, comment })
      w.set(new Date(w.clock.now.getTime() + MIN))
    }
    return { ...w, b, c }
  }

  it('Admin: every feedback with date, doctor, rating, comment, category + source, summary and reason; no patient contact details', async () => {
    const w = await filled()
    const body = (await w.admin.get('/api/admin/feedback').expect(200)).body
    expect(body.feedback).toHaveLength(3)
    expect(body.feedback[0]).toMatchObject({ doctorName: 'Dr Two', rating: 3, comment: 'Okay visit', category: 'suggestion', categorySource: 'ai', summary: 'Wants shorter forms.', reason: 'Because.' }) // newest first
    expect(body.feedback[0].atIst).toMatch(/22 Oct 2026/)
    expect(JSON.stringify(body)).not.toMatch(/Asha|9000000000|pat@test|doc@test/)
  })
  it('Admin: filters by category and by doctor; "unsorted" finds the ones with no category', async () => {
    const w = await filled()
    const get = async (q) => (await w.admin.get(`/api/admin/feedback${q}`).expect(200)).body.feedback
    expect((await get('?category=complaint')).map((f) => f.rating)).toEqual([1])
    expect((await get('?category=praise')).map((f) => f.rating)).toEqual([5])
    expect(await get('?category=urgent')).toHaveLength(0)
    expect((await get(`?doctorId=${w.doc.doctorId}`)).map((f) => f.rating).sort()).toEqual([1, 5])
    expect((await get(`?doctorId=${w.doc2.doctorId}&category=suggestion`))).toHaveLength(1)
    w.db.prepare("UPDATE feedback SET category = NULL, category_source = 'rule' WHERE rating = 3").run()
    expect((await get('?category=unsorted')).map((f) => f.rating)).toEqual([3])
    expect((await w.admin.get('/api/admin/feedback?category=bogus')).status).toBe(400)
  })
  it('Admin: the average rating per doctor, and overall', async () => {
    const w = await filled()
    const { perDoctor, overall } = (await w.admin.get('/api/admin/feedback').expect(200)).body
    expect(perDoctor.find((d) => d.name === 'Dr One')).toMatchObject({ average: 3, count: 2 })
    expect(perDoctor.find((d) => d.name === 'Dr Two')).toMatchObject({ average: 3, count: 1 })
    expect(overall).toEqual({ count: 3, average: 3 })
  })
  it('only the admin sees the Feedback page data', async () => {
    const w = await filled()
    expect((await w.doctor.get('/api/admin/feedback')).status).toBe(403)
    expect((await w.patient.get('/api/admin/feedback')).status).toBe(403)
    expect((await w.anon().get('/api/admin/feedback')).status).toBe(401)
  })

  it('Doctor: sees their own average and comments (not other doctors\', no patient details); nobody else can', async () => {
    const w = await filled()
    const mine = (await w.doctor.get('/api/doctor/feedback').expect(200)).body
    expect(mine).toMatchObject({ count: 2, average: 3 })
    expect(mine.recent.map((f) => f.comment)).toEqual(['Waited far too long', 'Wonderful care'])
    expect(JSON.stringify(mine)).not.toMatch(/Asha|9000000000|pat@test|Okay visit|category|summary/)
    expect((await w.doctor2.get('/api/doctor/feedback').expect(200)).body.recent.map((f) => f.comment)).toEqual(['Okay visit'])
    expect((await w.patient.get('/api/doctor/feedback')).status).toBe(403)
    expect((await w.admin.get('/api/doctor/feedback')).status).toBe(403)
    expect((await w.anon().get('/api/doctor/feedback')).status).toBe(401)
  })
  it('Doctor: a doctor with no feedback sees no average', async () => {
    const w = await world()
    expect((await w.doctor.get('/api/doctor/feedback').expect(200)).body).toEqual({ count: 0, average: null, recent: [] })
  })

  it('Patient (signed in): can leave feedback for their own completed visit only; others, doctors and the admin cannot', async () => {
    const w = await world()
    await w.complete()
    w.fake.ai = sorted('praise')
    const info = (await w.patient.get(`/api/patient/appointments/${w.id}/feedback`).expect(200)).body.feedback
    expect(info).toMatchObject({ doctorName: 'Dr One', visitDate: '22 Oct 2026', submitted: false })
    addPatient(w.db, 'other@test.local', 'Other Person')
    const stranger = await login(w.app, 'other@test.local', 'password-123')
    expect((await stranger.get(`/api/patient/appointments/${w.id}/feedback`)).status).toBe(404)
    expect((await stranger.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 1 })).status).toBe(404)
    expect((await w.doctor.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 1 })).status).toBe(403)
    expect((await w.admin.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 1 })).status).toBe(403)
    expect((await w.anon().post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 1 })).status).toBe(401)
    expect(w.db.prepare('SELECT COUNT(*) n FROM feedback').get().n).toBe(0)
    const ok = await w.patient.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 5, comment: 'Thanks' })
    expect(ok.status).toBe(201)
    await w.notifier.flush()
    expect(sheetRows(w)).toHaveLength(1)
    const pending = w.visit(w.doc, '2026-10-22T02:30:00.000Z', 'pending')
    expect((await w.patient.get(`/api/patient/appointments/${pending}/feedback`)).status).toBe(409)
    expect((await w.patient.post(`/api/patient/appointments/${pending}/feedback`).send({ rating: 5 })).status).toBe(409)
  })
  it('Patient: Visit history knows which visits were rated', async () => {
    const w = await world()
    await w.complete()
    let list = (await w.patient.get('/api/patient/appointments').expect(200)).body.past
    expect(list[0]).toMatchObject({ id: w.id, status: 'completed', feedbackRating: null })
    w.fake.ai = sorted('praise')
    await w.patient.post(`/api/patient/appointments/${w.id}/feedback`).send({ rating: 4, comment: 'Private comment' })
    list = (await w.patient.get('/api/patient/appointments').expect(200)).body.past
    expect(list[0].feedbackRating).toBe(4)
    expect(JSON.stringify(list)).not.toContain('Private comment')
  })

  it('Doctor cards and profile: average rating and count only when there is at least one feedback', async () => {
    const w = await filled()
    const list = (await w.anon().get('/api/public/doctors').expect(200)).body.doctors
    expect(list.find((d) => d.name === 'Dr One')).toMatchObject({ ratingAvg: 3, ratingCount: 2 })
    const profile = (await w.anon().get(`/api/public/doctors/${w.doc2.doctorId}`).expect(200)).body.doctor
    expect(profile).toMatchObject({ ratingAvg: 3, ratingCount: 1 })
    const empty = await world()
    const none = (await empty.anon().get('/api/public/doctors').expect(200)).body.doctors
    expect(none.every((d) => d.ratingAvg === null && d.ratingCount === 0)).toBe(true)
    const w2 = await withLink()
    w2.fake.ai = sorted('praise')
    await w2.send(w2.token, { rating: 4 })
    await w2.send(signFeedbackToken(w2.config.sessionSecret, w2.id), { rating: 5 }) // refused: still 4.0 from one feedback
    expect((await w2.anon().get('/api/public/doctors').expect(200)).body.doctors.find((d) => d.name === 'Dr One')).toMatchObject({ ratingAvg: 4, ratingCount: 1 })
  })
})
