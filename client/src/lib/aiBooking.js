// "Book this slot" hands the patient's own words to the existing booking form as the reason for the visit.
// They are kept in this browser tab only (sessionStorage), never in the address bar, and only used when the form is opened
// for exactly the doctor and slot that were suggested.
const KEY = 'curevia.aiBookingReason'

export function saveAiReason(doctorId, startUtc, text) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ doctorId: Number(doctorId), startUtc, text: String(text).slice(0, 500) })) } catch { /* private mode: the form just opens empty */ }
}
export function readAiReason(doctorId, startUtc) {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    return v && v.doctorId === Number(doctorId) && v.startUtc === startUtc ? v.text : ''
  } catch { return '' }
}
export function clearAiReason() {
  try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
