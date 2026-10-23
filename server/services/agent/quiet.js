import { addDays, istDate, istTime, istToUtcIso, formatIstTime } from '../../lib/time.js'

// Quiet hours: the agent sends no patient or doctor email from 10 PM to 8 AM India time. It holds the step until 8 AM,
// unless the appointment is less than 2 hours away. Slack alerts to the admin are never held.
// These are real clock times (they are not shortened by demo timing).
export const QUIET = { startHour: 22, endHour: 8, exemptWithinMin: 120 }

const hourIst = (iso) => Number(istTime(iso).slice(0, 2))
export const isQuietNow = (nowIso, q = QUIET) => {
  const h = hourIst(nowIso)
  return h >= q.startHour || h < q.endHour
}

// The next 8:00 AM IST after `nowIso`.
export function nextQuietEnd(nowIso, q = QUIET) {
  const date = istDate(nowIso)
  const at = (d) => istToUtcIso(d, `${String(q.endHour).padStart(2, '0')}:00`)
  return hourIst(nowIso) < q.endHour ? at(date) : at(addDays(date, 1))
}

// { hold: false } to send now, or { hold: true, until, untilText, why } to hold the email until the quiet hours end.
export function quietHold(nowIso, appointmentStartIso, { enabled = true, q = QUIET } = {}) {
  if (!enabled || !isQuietNow(nowIso, q)) return { hold: false }
  const minutesAway = (new Date(appointmentStartIso).getTime() - new Date(nowIso).getTime()) / 60000
  if (minutesAway < q.exemptWithinMin) return { hold: false, exempt: true }
  const until = nextQuietEnd(nowIso, q)
  const dayNote = istDate(until) === istDate(nowIso) ? '' : ' tomorrow'
  const untilText = `${formatIstTime(until)} IST${dayNote}`
  return {
    hold: true,
    until,
    untilText,
    why: `It is ${formatIstTime(nowIso)} IST, inside quiet hours (10 PM to 8 AM IST), and the appointment is more than 2 hours away.`
  }
}
