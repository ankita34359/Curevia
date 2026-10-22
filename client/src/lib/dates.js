// "in 2 days 3 hours" style countdown. `now` is a ms timestamp so callers can tick it.
export function countdown(startUtc, endUtc, now) {
  const start = new Date(startUtc).getTime()
  const end = new Date(endUtc).getTime()
  if (now >= end) return { text: 'This visit has ended', state: 'past' }
  if (now >= start) return { text: 'Happening now', state: 'now' }
  const mins = Math.max(1, Math.round((start - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (d >= 1) return { text: `in ${plural(d, 'day')}${h ? ` ${plural(h, 'hour')}` : ''}`, state: 'future' }
  if (h >= 1) return { text: `in ${plural(h, 'hour')}${m ? ` ${plural(m, 'minute')}` : ''}`, state: 'future' }
  return { text: `in ${plural(m, 'minute')}`, state: 'soon' }
}
export const addDaysStr = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export const toTimeGroup = (hhmm) => (hhmm < '12:00' ? 'Morning' : hhmm < '17:00' ? 'Afternoon' : 'Evening')
