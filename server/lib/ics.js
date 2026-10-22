const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// RFC 5545 lines are limited to 75 octets; longer ones are folded with a leading space.
function fold(line) {
  const out = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n')
}

export function appointmentIcs({ id, startUtc, endUtc, doctorName, department, status, now }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Curevia//Appointments//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:appointment-${id}@curevia`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(startUtc)}`,
    `DTEND:${stamp(endUtc)}`,
    `SUMMARY:${esc(`Appointment with ${doctorName}`)}`,
    `DESCRIPTION:${esc(`${department} appointment booked on Curevia. Status: ${status === 'confirmed' ? 'confirmed' : 'waiting for the doctor to confirm'}.`)}`,
    `STATUS:${status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Appointment in 1 hour', 'TRIGGER:-PT1H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}
