// All times are stored in UTC (ISO strings) and shown in India time (IST, UTC+05:30, no daylight saving).
const IST_OFFSET_MS = 330 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

function istParts(input) {
  const d = new Date(new Date(input).getTime() + IST_OFFSET_MS)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() }
}

export const istDate = (input) => {
  const p = istParts(input)
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`
}
export const istTime = (input) => {
  const p = istParts(input)
  return `${pad(p.h)}:${pad(p.mi)}`
}
export const istWeekday = (input) => istParts(input).wd

// "24 Oct 2026"
export const formatIstDate = (input) => {
  const p = istParts(input)
  return `${p.d} ${MONTHS[p.mo]} ${p.y}`
}
// "10:30 AM"
export const formatIstTime = (input) => {
  const p = istParts(input)
  return `${p.h % 12 || 12}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`
}
// "24 Oct 2026, 10:30 AM"
export const formatIst = (input) => `${formatIstDate(input)}, ${formatIstTime(input)}`

// ("2026-10-24", "10:30") in IST -> UTC ISO string
export function istToUtcIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [h, mi] = timeStr.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, h, mi) - IST_OFFSET_MS).toISOString()
}

export const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
export const isTimeStr = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)
export const timeToMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
export const minutesToTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export const weekdayOfDate = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay()
