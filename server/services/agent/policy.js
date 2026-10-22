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
  offerWhenWithinMin: 12 * 60
}

const gapOk = (facts, action) => {
  const since = facts.minutesSinceLast[action]
  return since === null || since === undefined || since >= LIMITS.minGapMinutes[action]
}

// Returns { ok: true, decision } with a cleaned-up decision, or { ok: false, why }.
export function validateDecision(raw, facts) {
  if (!raw || !ACTIONS.includes(raw.action)) return { ok: false, why: 'unknown action' }
  const c = facts.counts
  const d = { action: raw.action, reason: String(raw.reason || '').slice(0, 500), waitMinutes: null, options: [], note: '' }
  switch (raw.action) {
    case 'remind_doctor':
      if (facts.caseType !== 'pending') return { ok: false, why: 'only a pending request can be reminded to the doctor' }
      if (c.doctorReminders >= LIMITS.maxDoctorReminders) return { ok: false, why: `already sent ${LIMITS.maxDoctorReminders} doctor reminders` }
      if (!gapOk(facts, 'remind_doctor')) return { ok: false, why: 'a doctor reminder was sent less than an hour ago' }
      break
    case 'remind_patient':
      if (c.patientReminders >= LIMITS.maxPatientReminders) return { ok: false, why: `already sent ${LIMITS.maxPatientReminders} patient reminders` }
      if (!gapOk(facts, 'remind_patient')) return { ok: false, why: 'a patient reminder was sent less than an hour ago' }
      break
    case 'alert_admin':
      if (c.adminAlerts >= LIMITS.maxAdminAlerts) return { ok: false, why: 'the admin was already alerted for this case' }
      break
    case 'offer_slots_to_patient': {
      if (c.offers >= LIMITS.maxOffers) return { ok: false, why: `already offered slots ${LIMITS.maxOffers} times` }
      if (!gapOk(facts, 'offer_slots_to_patient')) return { ok: false, why: 'slots were offered less than 2 hours ago' }
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
      d.waitMinutes = Math.min(LIMITS.waitMax, Math.max(LIMITS.waitMin, Math.round(Number(raw.waitMinutes) || 30)))
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
export function fixedRules(facts) {
  const { counts: c, caseType, minutesSinceCaseStart: age } = facts
  const topOptions = () => facts.options.slice(0, LIMITS.maxSlotsPerOffer)
  const pick = (action, reason, extra = {}) => ({ action, reason: `Fixed rule: ${reason}`, waitMinutes: null, options: [], note: '', ...extra })
  const ok = (action) => validateDecision({ action, slotOptionIds: topOptions().map((o) => o.id) }, facts).ok

  if (caseType === 'pending') {
    if (age >= LIMITS.alertAdminAfterMin && c.adminAlerts < 1) return pick('alert_admin', `still pending after ${Math.floor(age / 60)} hours`)
    if (facts.minutesUntilAppointment < LIMITS.offerWhenWithinMin && age >= LIMITS.remindDoctorAfterMin && c.offers < 1 && facts.options.length && ok('offer_slots_to_patient'))
      return pick('offer_slots_to_patient', 'appointment is less than 12 hours away and still pending', { options: topOptions() })
    if (age >= LIMITS.remindDoctorAfterMin && c.doctorReminders < 1 && ok('remind_doctor')) return pick('remind_doctor', 'doctor has not confirmed after 2 hours')
    if (age >= 2 * LIMITS.remindDoctorAfterMin && c.doctorReminders < 2 && ok('remind_doctor')) return pick('remind_doctor', 'doctor still has not confirmed after 4 hours')
    if (c.offers >= 1 && c.patientReminders < 1 && (facts.minutesSinceLast.offer_slots_to_patient ?? 0) >= 180 && ok('remind_patient')) return pick('remind_patient', 'patient has not responded to the offered slots')
    return pick('wait', 'nothing is due yet', { waitMinutes: 30 })
  }
  // needs_rebooking
  if (c.offers < 1 && facts.options.length && ok('offer_slots_to_patient')) return pick('offer_slots_to_patient', 'offering the earliest free slots', { options: topOptions() })
  if (age >= LIMITS.alertAdminAfterMin && c.adminAlerts < 1) return pick('alert_admin', `patient still has no new slot after ${Math.floor(age / 60)} hours`)
  if (!facts.options.length && age >= LIMITS.remindDoctorAfterMin && c.adminAlerts < 1) return pick('alert_admin', 'no free slots to offer, a person needs to help')
  if (c.offers >= 1 && c.patientReminders < LIMITS.maxPatientReminders && (facts.minutesSinceLast.offer_slots_to_patient ?? 0) >= 180 && ok('remind_patient')) return pick('remind_patient', 'patient has not picked a new slot')
  return pick('wait', 'nothing is due yet', { waitMinutes: 30 })
}
