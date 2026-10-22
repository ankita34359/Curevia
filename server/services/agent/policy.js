// The agent's rules, as plain code. The AI only ever *suggests* one of these actions; every suggestion is checked
// here before anything happens. If the AI is down or its suggestion is refused, fixedRules() decides instead.
export const ACTIONS = ['remind_doctor', 'alert_admin', 'offer_slots_to_patient', 'remind_patient', 'wait', 'close_case']

export const LIMITS = {
  maxDoctorReminders: 2,
  maxPatientReminders: 2,
  maxAdminAlerts: 1, // at most once per case
  maxOffers: 3,
  maxSlotsPerOffer: 3,
  minGapMinutes: { remind_doctor: 60, remind_patient: 60, offer_slots_to_patient: 120 },
  waitMin: 5,
  waitMax: 720,
  // The defaults the AI is told to follow (also what fixedRules() does)
  remindDoctorAfterMin: 120,
  alertAdminAfterMin: 360,
  offerWhenWithinMin: 12 * 60,
  // Timings that used to be written inline in the agent and the fixed rules
  minCaseAgeMin: 30, // a request younger than this is not judged yet
  patientFollowUpAfterMin: 180, // after slots were offered, remind the patient when they have not answered for this long
  defaultWaitMin: 30,
  nextCheckAfterMin: { remind_doctor: 60, remind_patient: 60, offer_slots_to_patient: 120, alert_admin: 120 }
}

// Demo timing (AGENT_DEMO_MINUTES = N): the 2-hour mark becomes N minutes, so every wait shrinks by N/120
// (N = 2: remind the doctor after 2 min, alert the admin after 6 min, a second reminder at 4 min, and so on).
// Real clock facts are not scaled: how far away the appointment is, and the 7 days after which a rebooking is handed over.
// With no demo value this returns LIMITS itself, so normal behaviour is untouched.
export function limitsFor(demoMinutes) {
  const n = Number(demoMinutes)
  if (!demoMinutes || !Number.isFinite(n) || n <= 0) return LIMITS
  const k = Math.min(n, 120) / 120
  const sc = (min) => Math.round(min * k * 100) / 100
  const atLeastOne = (min) => Math.max(1, sc(min))
  return {
    ...LIMITS,
    demo: true,
    minGapMinutes: Object.fromEntries(Object.entries(LIMITS.minGapMinutes).map(([a, m]) => [a, sc(m)])),
    waitMin: 1,
    waitMax: Math.max(1, Math.round(LIMITS.waitMax * k)),
    remindDoctorAfterMin: sc(LIMITS.remindDoctorAfterMin),
    alertAdminAfterMin: sc(LIMITS.alertAdminAfterMin),
    minCaseAgeMin: sc(LIMITS.minCaseAgeMin),
    patientFollowUpAfterMin: sc(LIMITS.patientFollowUpAfterMin),
    defaultWaitMin: atLeastOne(LIMITS.defaultWaitMin),
    nextCheckAfterMin: Object.fromEntries(Object.entries(LIMITS.nextCheckAfterMin).map(([a, m]) => [a, atLeastOne(m)]))
  }
}

// "2 hours", "45 minutes", "30 seconds": how long a time span is, for reasons that people read.
export function span(min) {
  if (min === 60) return 'an hour'
  if (min >= 60) { const h = Math.floor(min / 60); return `${h} hour${h === 1 ? '' : 's'}` }
  if (min >= 1) { const m = Math.round(min * 10) / 10; return `${m} minute${m === 1 ? '' : 's'}` }
  const sec = Math.max(1, Math.round(min * 60))
  return `${sec} second${sec === 1 ? '' : 's'}`
}

const gapOk = (facts, action, limits = LIMITS) => {
  const since = facts.minutesSinceLast[action]
  return since === null || since === undefined || since >= limits.minGapMinutes[action]
}

// Returns { ok: true, decision } with a cleaned-up decision, or { ok: false, why }.
export function validateDecision(raw, facts, limits = LIMITS) {
  if (!raw || !ACTIONS.includes(raw.action)) return { ok: false, why: 'unknown action' }
  const c = facts.counts
  const d = { action: raw.action, reason: String(raw.reason || '').slice(0, 500), waitMinutes: null, options: [], note: '' }
  switch (raw.action) {
    case 'remind_doctor':
      if (facts.caseType !== 'pending') return { ok: false, why: 'only a pending request can be reminded to the doctor' }
      if (c.doctorReminders >= LIMITS.maxDoctorReminders) return { ok: false, why: `already sent ${LIMITS.maxDoctorReminders} doctor reminders` }
      if (!gapOk(facts, 'remind_doctor', limits)) return { ok: false, why: `a doctor reminder was sent less than ${span(limits.minGapMinutes.remind_doctor)} ago` }
      break
    case 'remind_patient':
      if (c.patientReminders >= LIMITS.maxPatientReminders) return { ok: false, why: `already sent ${LIMITS.maxPatientReminders} patient reminders` }
      if (!gapOk(facts, 'remind_patient', limits)) return { ok: false, why: `a patient reminder was sent less than ${span(limits.minGapMinutes.remind_patient)} ago` }
      break
    case 'alert_admin':
      if (c.adminAlerts >= LIMITS.maxAdminAlerts) return { ok: false, why: 'the admin was already alerted for this case' }
      break
    case 'offer_slots_to_patient': {
      if (c.offers >= LIMITS.maxOffers) return { ok: false, why: `already offered slots ${LIMITS.maxOffers} times` }
      if (!gapOk(facts, 'offer_slots_to_patient', limits)) return { ok: false, why: `slots were offered less than ${span(limits.minGapMinutes.offer_slots_to_patient)} ago` }
      const ids = [...new Set(Array.isArray(raw.slotOptionIds) ? raw.slotOptionIds : [])]
      if (!ids.length) return { ok: false, why: 'no slots chosen' }
      if (ids.length > LIMITS.maxSlotsPerOffer) return { ok: false, why: `more than ${LIMITS.maxSlotsPerOffer} slots chosen` }
      const chosen = ids.map((id) => facts.options.find((o) => o.id === id))
      if (chosen.some((o) => !o)) return { ok: false, why: 'a chosen slot is not one of the free options given' } // never offer a slot that was not given as free
      d.options = chosen
      d.note = cleanNote(raw.emailNote)
      break
    }
    case 'wait':
      d.waitMinutes = Math.min(limits.waitMax, Math.max(limits.waitMin, Math.round(Number(raw.waitMinutes) || limits.defaultWaitMin)))
      break
    case 'close_case':
      // Closing hands the case to a human, so the admin must already know about it.
      if (c.adminAlerts < 1) return { ok: false, why: 'a case can only be closed after the admin has been alerted' }
      break
  }
  return { ok: true, decision: d }
}

// The AI's friendly note goes into an email. Keep it short, plain text, and free of links.
export function cleanNote(text) {
  const t = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || t.length > 600 || /https?:|www\.|@/i.test(t)) return ''
  return t
}

// What happens when the AI cannot be used: simple, predictable rules with the same defaults.
export function fixedRules(facts, limits = LIMITS) {
  const { counts: c, caseType, minutesSinceCaseStart: age } = facts
  const topOptions = () => facts.options.slice(0, limits.maxSlotsPerOffer)
  const pick = (action, reason, extra = {}) => ({ action, reason: `Fixed rule: ${reason}`, waitMinutes: null, options: [], note: '', ...extra })
  const ok = (action) => validateDecision({ action, slotOptionIds: topOptions().map((o) => o.id) }, facts, limits).ok
  const ago = (min) => span(min >= 60 ? Math.floor(min / 60) * 60 : min)

  if (caseType === 'pending') {
    if (age >= limits.alertAdminAfterMin && c.adminAlerts < 1) return pick('alert_admin', `still pending after ${ago(age)}`)
    if (facts.minutesUntilAppointment < limits.offerWhenWithinMin && age >= limits.remindDoctorAfterMin && c.offers < 1 && facts.options.length && ok('offer_slots_to_patient'))
      return pick('offer_slots_to_patient', 'appointment is less than 12 hours away and still pending', { options: topOptions() })
    if (age >= limits.remindDoctorAfterMin && c.doctorReminders < 1 && ok('remind_doctor')) return pick('remind_doctor', `doctor has not confirmed after ${span(limits.remindDoctorAfterMin)}`)
    if (age >= 2 * limits.remindDoctorAfterMin && c.doctorReminders < 2 && ok('remind_doctor')) return pick('remind_doctor', `doctor still has not confirmed after ${span(2 * limits.remindDoctorAfterMin)}`)
    if (c.offers >= 1 && c.patientReminders < 1 && (facts.minutesSinceLast.offer_slots_to_patient ?? 0) >= limits.patientFollowUpAfterMin && ok('remind_patient')) return pick('remind_patient', 'patient has not responded to the offered slots')
    return pick('wait', 'nothing is due yet', { waitMinutes: limits.defaultWaitMin })
  }
  // needs_rebooking
  if (c.offers < 1 && facts.options.length && ok('offer_slots_to_patient')) return pick('offer_slots_to_patient', 'offering the earliest free slots', { options: topOptions() })
  if (age >= limits.alertAdminAfterMin && c.adminAlerts < 1) return pick('alert_admin', `patient still has no new slot after ${ago(age)}`)
  if (!facts.options.length && age >= limits.remindDoctorAfterMin && c.adminAlerts < 1) return pick('alert_admin', 'no free slots to offer, a person needs to help')
  if (c.offers >= 1 && c.patientReminders < limits.maxPatientReminders && (facts.minutesSinceLast.offer_slots_to_patient ?? 0) >= limits.patientFollowUpAfterMin && ok('remind_patient')) return pick('remind_patient', 'patient has not picked a new slot')
  return pick('wait', 'nothing is due yet', { waitMinutes: limits.defaultWaitMin })
}

// The next thing the rules will do for a case that is waiting, and in how many minutes from now.
// Used to tell the admin "Waiting: remind doctor at 8:30 PM IST". Returns null when nothing more is scheduled.
const STEP_LABEL = {
  remind_doctor: 'remind the doctor',
  remind_doctor_again: 'remind the doctor again',
  alert_admin: 'alert the admin',
  offer_slots_to_patient: 'offer other slots to the patient',
  remind_patient: 'remind the patient'
}
export function nextStep(facts, limits = LIMITS) {
  const { counts: c, caseType, minutesSinceCaseStart: age } = facts
  const since = facts.minutesSinceLast
  const steps = []
  const add = (action, dueInMin) => steps.push({ action, label: STEP_LABEL[action], inMin: Math.max(0, Math.round(dueInMin * 100) / 100) })
  const gapLeft = (action) => (since[action] === null || since[action] === undefined ? 0 : limits.minGapMinutes[action] - since[action])

  if (caseType === 'pending') {
    if (c.doctorReminders < 1) add('remind_doctor', Math.max(limits.remindDoctorAfterMin - age, gapLeft('remind_doctor')))
    else if (c.doctorReminders < limits.maxDoctorReminders) add('remind_doctor_again', Math.max(2 * limits.remindDoctorAfterMin - age, gapLeft('remind_doctor')))
    if (c.adminAlerts < 1) add('alert_admin', limits.alertAdminAfterMin - age)
    if (c.offers < 1 && facts.minutesUntilAppointment >= limits.offerWhenWithinMin) add('offer_slots_to_patient', Math.max(facts.minutesUntilAppointment - limits.offerWhenWithinMin + 1, limits.remindDoctorAfterMin - age))
  } else {
    if (c.offers < 1) add('offer_slots_to_patient', 0)
    else if (c.patientReminders < limits.maxPatientReminders) add('remind_patient', Math.max(limits.patientFollowUpAfterMin - (since.offer_slots_to_patient ?? 0), gapLeft('remind_patient')))
    if (c.adminAlerts < 1) add('alert_admin', limits.alertAdminAfterMin - age)
  }
  steps.sort((a, b) => a.inMin - b.inMin)
  return steps[0] || null
}
