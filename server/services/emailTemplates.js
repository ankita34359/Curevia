const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function layout(title, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a">
  <div style="padding:16px 0;font-size:22px;font-weight:700;color:#0f766e">Curevia</div>
  <h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
  ${bodyHtml}
  <p style="margin-top:32px;font-size:12px;color:#5b7480">This is an automated message from Curevia. Please do not share this email.</p>
</div>`
}

const button = (href, label) =>
  `<p><a href="${esc(href)}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`

export function verifyEmail({ name, link }) {
  return {
    subject: 'Verify your email for Curevia',
    html: layout('Verify your email', `<p>Hello ${esc(name)},</p><p>Please confirm your email address to start booking appointments. The link works for 48 hours.</p>${button(link, 'Verify my email')}`)
  }
}

export function doctorSetPassword({ name, link }) {
  return {
    subject: 'Set your Curevia password',
    html: layout('Welcome to Curevia', `<p>Hello ${esc(name)},</p><p>An account has been created for you. Choose your password using the button below. The link works for 48 hours and can be used once.</p>${button(link, 'Set my password')}`)
  }
}

export function resetPassword({ name, link }) {
  return {
    subject: 'Reset your Curevia password',
    html: layout('Reset your password', `<p>Hello ${esc(name)},</p><p>Use the button below to choose a new password. The link works for 1 hour and can be used once. If you did not ask for this, you can ignore this email.</p>${button(link, 'Choose a new password')}`)
  }
}

// ---- appointment emails (all times are India time) ----
const row = (k, v) => `<tr><td style="padding:4px 16px 4px 0;color:#5b7480">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`
const details = (a) =>
  `<table style="margin:12px 0;border-collapse:collapse;font-size:14px">${row('Doctor', a.doctorName)}${row('Department', a.department)}${row('When (IST)', a.startIst)}${a.patientName ? row('Patient', a.patientName) : ''}</table>`

export function patientRequestReceived(a, { link }) {
  return {
    subject: `We received your appointment request for ${a.startIst}`,
    html: layout('Request received', `<p>Hello ${esc(a.patientName)},</p><p>We have received your appointment request. It is <strong>pending</strong> until the doctor confirms, and we will email you as soon as they do.</p>${details(a)}${button(link, 'View my appointments')}`)
  }
}
export function patientConfirmed(a, { link }) {
  return {
    subject: `Your appointment is confirmed: ${a.startIst}`,
    html: layout('Your appointment is confirmed', `<p>Hello ${esc(a.patientName)},</p><p>${esc(a.doctorName)} has confirmed your appointment. We will send you reminders before the visit.</p>${details(a)}${button(link, 'View my appointment')}`)
  }
}
export function patientCancelled(a, { by, reason, link }) {
  const who = by === 'doctor' ? 'the doctor' : 'you'
  return {
    subject: `Your appointment on ${a.startIst} was cancelled`,
    html: layout('Appointment cancelled', `<p>Hello ${esc(a.patientName)},</p><p>Your appointment was cancelled by ${who}.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ''}${details(a)}<p>You can book another time whenever you like.</p>${button(link, 'Find a doctor')}`)
  }
}
export function patientNeedsRebooking(a, { options, reason, link }) {
  const list = options.length
    ? `<p>Here are some times that are free right now:</p><ul>${options.map((o) => `<li>${esc(o.startIst)} with ${esc(o.doctorName)}</li>`).join('')}</ul>`
    : '<p>There are no free times right now. We will keep looking and let you know.</p>'
  return {
    subject: 'Please choose a new time for your appointment',
    html: layout('Your appointment needs a new time', `<p>Hello ${esc(a.patientName)},</p><p>Your appointment on <strong>${esc(a.startIst)}</strong> with ${esc(a.doctorName)} can no longer go ahead.${reason ? ` Reason: ${esc(reason)}.` : ''}</p>${list}${button(link, 'Choose a new time')}`)
  }
}
export function doctorNewRequest(a, { link }) {
  return {
    subject: `New appointment request for ${a.startIst}`,
    html: layout('New appointment request', `<p>Hello ${esc(a.doctorName)},</p><p>A patient has asked for an appointment. Please confirm or cancel it.</p><table style="margin:12px 0;border-collapse:collapse;font-size:14px">${row('Patient', `${a.patientName}, ${a.age} yrs, ${a.gender}`)}${row('When (IST)', a.startIst)}${row('Reason', a.reason)}</table>${button(link, 'Open my dashboard')}`)
  }
}
export function doctorPatientCancelled(a, { reason, link }) {
  return {
    subject: `Appointment cancelled by the patient: ${a.startIst}`,
    html: layout('Patient cancelled', `<p>Hello ${esc(a.doctorName)},</p><p>${esc(a.patientName)} has cancelled the appointment. The slot is free again.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ''}${details({ ...a, patientName: null })}${button(link, 'Open my dashboard')}`)
  }
}

export function patientReminder(a, { hours, link }) {
  return {
    subject: hours === 1 ? `Reminder: your appointment is in about 1 hour (${a.startIst})` : `Reminder: your appointment is tomorrow, ${a.startIst}`,
    html: layout(hours === 1 ? 'Your appointment is in about an hour' : 'Your appointment is coming up', `<p>Hello ${esc(a.patientName)},</p><p>This is a friendly reminder about your confirmed appointment.</p>${details(a)}<p>Please arrive about 10 minutes early. If you can no longer come, you can cancel up to 1 hour before.</p>${button(link, 'View my appointment')}`)
  }
}
export function doctorReminder(a, { link }) {
  return {
    subject: `Reminder: appointment request still waiting for you (${a.startIst})`,
    html: layout('A request is waiting for your reply', `<p>Hello ${esc(a.doctorName)},</p><p>An appointment request is still pending. Please confirm or cancel it so the patient knows where they stand.</p><table style="margin:12px 0;border-collapse:collapse;font-size:14px">${row('Patient', `${a.patientName}, ${a.age} yrs`)}${row('When (IST)', a.startIst)}</table>${button(link, 'Open my dashboard')}`)
  }
}
export function patientPendingUpdate(a, { link }) {
  return {
    subject: 'Your appointment request is still waiting for the doctor',
    html: layout('Still waiting for the doctor', `<p>Hello ${esc(a.patientName)},</p><p>Your request is still waiting for ${esc(a.doctorName)} to confirm. We have reminded them. You do not need to do anything, and we will email you as soon as they reply.</p>${details(a)}${button(link, 'View my appointments')}`)
  }
}
export function patientRebookReminder(a, { link }) {
  return {
    subject: 'Reminder: please choose a new time for your appointment',
    html: layout('Please choose a new time', `<p>Hello ${esc(a.patientName)},</p><p>Your appointment on <strong>${esc(a.startIst)}</strong> with ${esc(a.doctorName)} still needs a new time. It only takes a moment to pick one.</p>${button(link, 'Choose a new time')}`)
  }
}
// The AI writes a short friendly note; the code adds the greeting, the slot list and the link, so times can never be invented.
export function patientOfferSlots(a, { note, options, link }) {
  return {
    subject: 'Other times are available for your appointment',
    html: layout('Other times are available', `<p>Hello ${esc(a.patientName)},</p>${note ? `<p>${esc(note)}</p>` : ''}<p>These times are free right now:</p><ul>${options.map((o) => `<li>${esc(o.startIst)} with ${esc(o.doctorName)}</li>`).join('')}</ul><p>Nothing changes unless you choose one yourself.</p>${button(link, 'Choose a time')}`)
  }
}

// A pending request whose appointment time passed without the doctor confirming it.
export function patientRequestExpired(a, { link }) {
  return {
    subject: 'Your appointment request expired: please book again',
    html: layout('Your request expired', `<p>Hello ${esc(a.patientName)},</p><p>Your request for <strong>${esc(a.startIst)}</strong> with ${esc(a.doctorName)} was not confirmed before that time, so it has expired. We are sorry about that. Nothing is booked for you.</p><p>Please book again and choose a new time.</p>${button(link, 'Book a new appointment')}`)
  }
}

// The doctor marked the lab report ready. Only the doctor's own short note is included: no results, no file.
export function patientLabReportReady(a, { note, link }) {
  return {
    subject: 'Your lab report is ready',
    html: layout('Your lab report is ready', `<p>Hello ${esc(a.patientName)},</p><p>Your lab report from your visit on <strong>${esc(a.startIst)}</strong> with ${esc(a.doctorName)} is ready.</p>${note ? `<p><strong>Note from your doctor:</strong> ${esc(note)}</p>` : ''}<p><strong>How to collect it:</strong> please collect your report from the lab. If you are not sure where it is, ask any member of staff. We do not send results by email.</p>${button(link, 'View my appointments')}`)
  }
}

// The morning schedule for one doctor. `items` are today's pending and confirmed appointments, already sorted by time.
const cap = (w) => String(w || '').charAt(0).toUpperCase() + String(w || '').slice(1)
const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1).trimEnd()}…` : String(text))
export function doctorDailySchedule({ doctorName, dateText, items, pendingToday, pendingTotal, link }) {
  const th = 'padding:6px 8px;text-align:left;font-size:12px;color:#5b7480;border-bottom:1px solid #d9e4e8'
  const td = 'padding:8px;font-size:13px;vertical-align:top;border-bottom:1px solid #eef3f5'
  const rows = items.map((i) => `<tr><td style="${td};white-space:nowrap;font-weight:600">${esc(i.time)}</td><td style="${td}">${esc(i.patientName)}</td><td style="${td}">${esc(i.age)}</td><td style="${td}">${esc(cap(i.gender))}</td><td style="${td}">${esc(clip(i.reason, 200))}</td><td style="${td};white-space:nowrap;${i.status === 'pending' ? 'color:#b45309;font-weight:600' : ''}">${i.status === 'pending' ? 'Pending' : 'Confirmed'}</td></tr>`).join('')
  const pending = pendingTotal > 0
    ? `<p><strong>${pendingTotal} request${pendingTotal === 1 ? '' : 's'} still pending</strong> and waiting for your confirmation${pendingToday > 0 ? ` (${pendingToday} of them today)` : ''}.</p>`
    : '<p>No requests are waiting for your confirmation.</p>'
  return {
    subject: `Your appointments for today (${dateText})`,
    html: layout('Your appointments for today', `<p>Hello ${esc(doctorName)},</p><p>You have <strong>${items.length} appointment${items.length === 1 ? '' : 's'}</strong> today, ${esc(dateText)}.</p><table style="width:100%;border-collapse:collapse;margin:12px 0"><thead><tr><th style="${th}">Time</th><th style="${th}">Patient</th><th style="${th}">Age</th><th style="${th}">Gender</th><th style="${th}">Reason</th><th style="${th}">Status</th></tr></thead><tbody>${rows}</tbody></table>${pending}${button(link, 'Open my dashboard')}`)
  }
}

// Sent once after the doctor marks a visit completed. The link is signed and belongs to this one visit.
export function patientFeedbackRequest(a, { link }) {
  return {
    subject: `How was your visit with ${a.doctorName}?`,
    html: layout('How was your visit?', `<p>Hello ${esc(a.patientName)},</p><p>Thank you for visiting ${esc(a.doctorName)} on <strong>${esc(a.startIst)}</strong>. It takes less than a minute to tell us how it went: a star rating and, if you like, a short comment.</p>${button(link, 'Share my feedback')}<p style="font-size:13px;color:#5b7480">Please do not put test results or other private medical details in your comment. If you need medical help, do not wait for a reply to this survey: for an emergency, call 108.</p>`)
  }
}
