import { z } from 'zod'
import { formatIst } from '../../lib/time.js'
import { APPT_SELECT } from '../appointments.js'
import { deliver } from '../deliveries.js'
import { findBookableSlot, rebookOptions } from '../scheduling.js'
import * as t from '../emailTemplates.js'
import { LIMITS, fixedRules, validateDecision } from './policy.js'
import { DECISION_SCHEMA, SYSTEM_PROMPT } from './prompt.js'

const MAX_CASES_PER_TICK = 8
const GIVE_UP_AFTER_TRIES = 3
const STALE_REBOOKING_MIN = 7 * 24 * 60
const minutes = (ms) => Math.floor(ms / 60000)

const aiAnswer = z.object({
  action: z.string(),
  reason: z.string().max(1000),
  wait_minutes: z.number(),
  slot_option_ids: z.array(z.number().int()).max(20),
  email_note: z.string().max(2000)
})

// The agent: for each stuck booking, ask the AI for ONE action, check it against the rules, then do it.
// It can email, alert and wait. It has no way to book, confirm or cancel anything.
export function createAgent({ db, config, viasocket, mailer, notifications, clock = () => new Date(), model = {} }) {
  const aiModel = { service: model.service || 'openai', model: model.model || 'gpt-5-mini' }
  let running = false

  const logRow = (c, { source, action, reason, params = null, executed = 0, outcome, aiError = null }) =>
    db.prepare('INSERT INTO agent_log (appointment_id, case_type, source, action, reason, params, executed, outcome, ai_error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.caseType, source, action, String(reason).slice(0, 500), params ? JSON.stringify(params) : null, executed, String(outcome).slice(0, 300), aiError ? String(aiError).slice(0, 300) : null, clock().toISOString())

  const caseRow = (id, type) => db.prepare('SELECT * FROM agent_cases WHERE appointment_id = ? AND case_type = ?').get(id, type)
  const setCase = (id, type, f) => {
    const cur = caseRow(id, type)
    db.prepare('UPDATE agent_cases SET next_check_at = ?, closed_at = ?, closed_reason = ? WHERE appointment_id = ? AND case_type = ?').run(
      'nextCheckAt' in f ? f.nextCheckAt : cur.next_check_at, 'closedAt' in f ? f.closedAt : cur.closed_at, 'closedReason' in f ? f.closedReason : cur.closed_reason, id, type)
  }
  const inMinutes = (m) => new Date(clock().getTime() + m * 60000).toISOString()

  function openCases(nowIso) {
    const pending = db.prepare("SELECT id FROM appointments WHERE status = 'pending' AND start_utc > ? ORDER BY created_at").all(nowIso).map((r) => ({ id: r.id, caseType: 'pending' }))
    const rebooking = db.prepare("SELECT id FROM appointments WHERE status = 'needs_rebooking' ORDER BY updated_at").all().map((r) => ({ id: r.id, caseType: 'needs_rebooking' }))
    return [...rebooking, ...pending]
  }

  // Cases whose appointment is no longer stuck (confirmed, cancelled, rebooked, past) end by themselves.
  function closeResolved(open) {
    const openKeys = new Set(open.map((c) => `${c.id}:${c.caseType}`))
    for (const c of db.prepare('SELECT appointment_id, case_type FROM agent_cases WHERE closed_at IS NULL').all()) {
      if (openKeys.has(`${c.appointment_id}:${c.case_type}`)) continue
      const a = db.prepare('SELECT status FROM appointments WHERE id = ?').get(c.appointment_id)
      setCase(c.appointment_id, c.case_type, { closedAt: clock().toISOString(), closedReason: 'resolved' })
      logRow({ id: c.appointment_id, caseType: c.case_type }, { source: 'guard', action: 'close_case', reason: `Case resolved: the appointment is now ${String(a?.status).replace(/_/g, ' ')}.`, executed: 1, outcome: 'closed' })
    }
  }

  function buildFacts(c, nowIso) {
    const a = db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(c.id)
    const nowMs = new Date(nowIso).getTime()
    const startedAt = c.caseType === 'pending'
      ? a.created_at
      : db.prepare("SELECT MAX(created_at) AS at FROM appointment_events WHERE appointment_id = ? AND to_status = 'needs_rebooking'").get(c.id).at || a.updated_at
    const done = db.prepare('SELECT action, COUNT(*) AS n, MAX(created_at) AS last FROM agent_log WHERE appointment_id = ? AND case_type = ? AND executed = 1 GROUP BY action').all(c.id, c.caseType)
    const n = (action) => done.find((d) => d.action === action)?.n || 0
    const since = (action) => { const l = done.find((d) => d.action === action)?.last; return l ? minutes(nowMs - new Date(l).getTime()) : null }
    const options = rebookOptions(db, a, nowIso, { limit: 8, perDoctor: 4, leadMinutes: 60 }).map((o, i) => ({ id: i + 1, doctorId: o.doctorId, doctorName: o.doctorName, startUtc: o.startUtc, startIst: formatIst(o.startUtc), sameDoctor: o.doctorId === a.doctor_id }))
    return {
      appt: a,
      caseType: c.caseType,
      id: c.id,
      nowIso,
      minutesSinceCaseStart: minutes(nowMs - new Date(startedAt).getTime()),
      minutesUntilAppointment: minutes(new Date(a.start_utc).getTime() - nowMs),
      counts: { doctorReminders: n('remind_doctor'), patientReminders: n('remind_patient'), adminAlerts: n('alert_admin'), offers: n('offer_slots_to_patient') },
      minutesSinceLast: { remind_doctor: since('remind_doctor'), remind_patient: since('remind_patient'), offer_slots_to_patient: since('offer_slots_to_patient') },
      options
    }
  }

  // What the AI sees. No patient name, phone, email or reason for the visit: scheduling facts only.
  const aiMessage = (f) => JSON.stringify({
    now_ist: formatIst(f.nowIso),
    case_type: f.caseType,
    department: f.appt.department,
    doctor: f.appt.doctor_name,
    appointment_time_ist: formatIst(f.appt.start_utc),
    minutes_until_appointment: f.minutesUntilAppointment,
    minutes_since_case_started: f.minutesSinceCaseStart,
    doctor_cancel_reason: f.caseType === 'needs_rebooking' ? f.appt.cancel_reason || null : null,
    already_done: { doctor_reminders_sent: f.counts.doctorReminders, patient_reminders_sent: f.counts.patientReminders, admin_alerted: f.counts.adminAlerts > 0, slot_offers_sent: f.counts.offers, minutes_since_last_doctor_reminder: f.minutesSinceLast.remind_doctor, minutes_since_last_patient_reminder: f.minutesSinceLast.remind_patient, minutes_since_last_slot_offer: f.minutesSinceLast.offer_slots_to_patient },
    slot_options: f.options.map((o) => ({ id: o.id, doctor: o.doctorName, time_ist: o.startIst, same_doctor_as_booked: o.sameDoctor }))
  })

  async function askAi(f) {
    const raw = await viasocket.ai({
      threadId: `agent-case-${f.id}`,
      message: aiMessage(f),
      prompt: SYSTEM_PROMPT,
      responseType: 'json_schema',
      jsonSchema: DECISION_SCHEMA,
      service: aiModel.service,
      model: aiModel.model
    })
    const r = aiAnswer.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw)
    if (!r.success) throw new Error('The AI answer did not match the expected format')
    return { action: r.data.action, reason: r.data.reason, waitMinutes: r.data.wait_minutes, slotOptionIds: r.data.slot_option_ids, emailNote: r.data.email_note }
  }

  const toRaw = (d) => ({ action: d.action, reason: d.reason, waitMinutes: d.waitMinutes, slotOptionIds: d.options.map((o) => o.id), emailNote: d.note })

  async function decide(f, c) {
    let aiError = null
    try {
      const raw = await askAi(f)
      const v = validateDecision(raw, f)
      if (v.ok) return { source: 'ai', decision: v.decision, aiError: null }
      logRow(c, { source: 'ai', action: raw.action, reason: raw.reason, params: { slotOptionIds: raw.slotOptionIds }, executed: 0, outcome: `Refused by the rules: ${v.why}` })
      aiError = `The AI's suggestion was refused: ${v.why}`
    } catch (e) {
      aiError = e.message
    }
    const fb = validateDecision(toRaw(fixedRules(f)), f)
    return { source: 'fallback', decision: fb.ok ? fb.decision : { action: 'wait', reason: 'Fixed rule: nothing to do', waitMinutes: 30, options: [], note: '' }, aiError }
  }

  const link = (id) => `${config.appUrl}/my/rebook/${id}`

  async function execute(f, d) {
    const a = notifications.load(f.id)
    const nowIso = f.nowIso
    const to = (res) => (res.status === 'sent' ? { done: true, outcome: 'sent' } : { done: false, outcome: `${res.status}${res.error ? `: ${res.error}` : ''}` })
    switch (d.action) {
      case 'remind_doctor': {
        const m = t.doctorReminder(a, { link: `${config.appUrl}/doctor` })
        return to(await mailer.send({ type: 'agent_remind_doctor', dedupeKey: `email:agent_remind_doctor:${f.id}:${f.counts.doctorReminders + 1}`, appointmentId: f.id, to: a.doctorEmail, subject: m.subject, html: m.html }))
      }
      case 'remind_patient': {
        const m = f.caseType === 'pending' ? t.patientPendingUpdate(a, { link: `${config.appUrl}/my` }) : t.patientRebookReminder(a, { link: link(f.id) })
        return to(await mailer.send({ type: 'agent_remind_patient', dedupeKey: `email:agent_remind_patient:${f.id}:${f.counts.patientReminders + 1}`, appointmentId: f.id, to: a.email, subject: m.subject, html: m.html }))
      }
      case 'alert_admin': {
        const hours = Math.floor(f.minutesSinceCaseStart / 60)
        const text = `Curevia: appointment #${f.id} with ${a.doctor_name} (${a.department}) on ${a.startIst} IST needs a person. ${f.caseType === 'pending' ? `The doctor has not confirmed it after ${hours} h.` : `The patient has no new slot after ${hours} h.`} Details: ${config.appUrl}/admin/agent`
        return to(await notifications.slackAlert({ dedupeKey: `slack:agent_alert_admin:${f.id}`, text, appointmentId: f.id }))
      }
      case 'offer_slots_to_patient': {
        // Checked again right now: only slots that are still free are offered.
        const stillFree = d.options.filter((o) => findBookableSlot(db, o.doctorId, o.startUtc, nowIso))
        if (!stillFree.length) return { done: false, outcome: 'None of the chosen slots is free any more', refused: true }
        const m = t.patientOfferSlots(a, { note: d.note, options: stillFree, link: link(f.id) })
        const res = to(await mailer.send({ type: 'agent_offer_slots', dedupeKey: `email:agent_offer_slots:${f.id}:${f.counts.offers + 1}`, appointmentId: f.id, to: a.email, subject: m.subject, html: m.html }))
        return { ...res, params: { slots: stillFree.map((o) => `${o.startIst} ${o.doctorName}`) } }
      }
    }
    return { done: true, outcome: 'ok' }
  }

  const NEXT_CHECK = { remind_doctor: 60, remind_patient: 60, offer_slots_to_patient: 120, alert_admin: 120 }

  async function handleCase(c, summary) {
    const nowIso = clock().toISOString()
    let f = buildFacts(c, nowIso)
    if (c.caseType === 'pending' && f.minutesSinceCaseStart < 30) return
    if (c.caseType === 'needs_rebooking' && f.minutesSinceCaseStart > STALE_REBOOKING_MIN && f.counts.adminAlerts > 0) {
      setCase(c.id, c.caseType, { closedAt: nowIso, closedReason: 'stale' })
      logRow(c, { source: 'guard', action: 'close_case', reason: 'No answer from the patient after 7 days and the admin has been alerted. Handed over to a person.', executed: 1, outcome: 'closed' })
      summary.closed++
      return
    }
    let { source, decision, aiError } = await decide(f, c)
    // Safety net: the AI may not leave an old case with nobody told.
    if (decision.action === 'wait' && f.minutesSinceCaseStart >= LIMITS.alertAdminAfterMin && f.counts.adminAlerts < 1) {
      decision = { action: 'alert_admin', reason: `Safety rule: the case has been open for ${Math.floor(f.minutesSinceCaseStart / 60)} hours and nobody has been alerted yet.`, waitMinutes: null, options: [], note: '' }
      source = 'guard'
    }
    summary.decisions++
    if (source === 'fallback') summary.fallbacks++

    if (decision.action === 'wait') {
      setCase(c.id, c.caseType, { nextCheckAt: inMinutes(decision.waitMinutes) })
      logRow(c, { source, action: 'wait', reason: decision.reason, params: { waitMinutes: decision.waitMinutes }, executed: 1, outcome: `waiting ${decision.waitMinutes} minutes`, aiError })
      return
    }
    if (decision.action === 'close_case') {
      setCase(c.id, c.caseType, { closedAt: nowIso, closedReason: 'closed by agent' })
      logRow(c, { source, action: 'close_case', reason: decision.reason, executed: 1, outcome: 'closed', aiError })
      summary.closed++
      return
    }
    const res = await execute(f, decision)
    // A failed or skipped send does not use up a limit; after 3 tries it is given up so it cannot repeat forever.
    const tries = db.prepare("SELECT COUNT(*) n FROM agent_log WHERE appointment_id = ? AND case_type = ? AND action = ? AND executed = 0 AND outcome NOT LIKE 'Refused%'").get(c.id, c.caseType, decision.action).n
    const gaveUp = !res.done && !res.refused && tries + 1 >= GIVE_UP_AFTER_TRIES
    const executed = res.done || gaveUp ? 1 : 0
    logRow(c, { source, action: decision.action, reason: decision.reason, params: res.params || (decision.options.length ? { slots: decision.options.map((o) => `${o.startIst} ${o.doctorName}`) } : null), executed, outcome: gaveUp ? `gave up after ${GIVE_UP_AFTER_TRIES} tries (${res.outcome})` : res.outcome, aiError })
    if (res.done) summary.actions++
    else summary.notDelivered++
    setCase(c.id, c.caseType, { nextCheckAt: inMinutes(res.done ? NEXT_CHECK[decision.action] || 60 : 30) })
  }

  async function run({ timeUp = () => false } = {}) {
    if (running) return { skipped: 'already running' }
    running = true
    const summary = { cases: 0, decisions: 0, actions: 0, notDelivered: 0, fallbacks: 0, closed: 0 }
    try {
      const nowIso = clock().toISOString()
      const open = openCases(nowIso)
      closeResolved(open)
      let handled = 0
      for (const c of open) {
        if (handled >= MAX_CASES_PER_TICK || timeUp()) break
        if (!caseRow(c.id, c.caseType)) db.prepare('INSERT INTO agent_cases (appointment_id, case_type, created_at) VALUES (?,?,?)').run(c.id, c.caseType, nowIso)
        const row = caseRow(c.id, c.caseType)
        if (row.closed_at || (row.next_check_at && row.next_check_at > nowIso)) continue
        summary.cases++
        handled++
        try { await handleCase(c, summary) } catch (e) { console.error(`Agent failed on a case: ${e.message}`) }
      }
    } finally { running = false }
    return summary
  }

  return { run }
}
